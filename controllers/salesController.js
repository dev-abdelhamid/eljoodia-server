// controllers/sales.js
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Return = require('../models/Return');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create a sale (محسن بدعم lang و isRtl، و transformed data)
const createSale = async (req, res) => {
  const { items, totalAmount, status = 'completed', paymentMethod = 'cash', customerName, customerPhone, notes, lang = 'ar' } = req.body;
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء بيع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const branchId = req.user.branchId;

    if (!isValidObjectId(branchId)) {
      console.log('إنشاء بيع - معرف الفرع غير صالح:', { branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    // Validate items
    for (const item of items) {
      if (!isValidObjectId(item.product) || item.quantity < 1 || item.unitPrice < 0) {
        console.log('إنشاء بيع - عنصر غير صالح:', { product: item.product, quantity: item.quantity, unitPrice: item.unitPrice });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data' });
      }
      const inventory = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء بيع - الكمية غير كافية:', { product: item.product, currentStock: inventory?.currentStock, requestedQuantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient stock for product ${item.product}` });
      }
    }

    const saleCount = await Sale.countDocuments({}).session(session);
    const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;

    const sale = new Sale({
      saleNumber,
      branch: branchId,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      totalAmount,
      status,
      paymentMethod,
      customerName: customerName?.trim(),
      customerPhone: customerPhone?.trim(),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await sale.save({ session });

    // Update inventory for completed sales
    if (status === 'completed') {
      for (const item of items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: branchId },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `بيع #${saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: branchId,
          action: 'sale',
          quantity: -item.quantity,
          reference: `بيع #${saleNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId,
          productId: item.product,
          quantity: inventory.currentStock,
          type: 'sale',
        });
      }
    }

    const populatedSale = await Sale.findById(sale._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // Transform for language
    populatedSale.branch.displayName = isRtl ? (populatedSale.branch?.name || 'غير معروف') : (populatedSale.branch?.nameEn || populatedSale.branch?.name || 'Unknown');
    populatedSale.items = populatedSale.items.map((item) => ({
      ...item,
      productName: item.product?.name || 'منتج محذوف',
      productNameEn: item.product?.nameEn,
      displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
      displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      department: item.product?.department
        ? {
            ...item.product.department,
            displayName: isRtl ? (item.product.department.name || 'غير معروف') : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
          }
        : undefined,
    }));

    req.io?.emit('saleCreated', {
      saleId: sale._id,
      branchId,
    });

    console.log('إنشاء بيع - تم بنجاح:', {
      saleId: sale._id,
      branchId,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json(populatedSale);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء البيع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all sales (محسن بدعم returns و transformed)
const getSales = async (req, res) => {
  const { branch, page = 1, limit = 10, status, startDate, endDate, lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المبيعات - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      query.branch = req.user.branchId;
    }

    if (status) query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const sales = await Sale.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    const total = await Sale.countDocuments(query);

    const saleIds = sales.map((s) => s._id);
    const returns = await Return.find({ order: { $in: saleIds } })
      .populate('order', 'saleNumber')
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn',
      })
      .lean();

    const transformedSales = sales.map((sale) => ({
      ...sale,
      orderNumber: sale.saleNumber,
      branch: sale.branch ? {
        ...sale.branch,
        displayName: isRtl ? (sale.branch.name || 'غير معروف') : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
      } : {
        displayName: isRtl ? 'غير معروف' : 'Unknown',
      },
      items: sale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? (item.product.department.name || 'غير معروف') : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      })),
      createdAt: new Date(sale.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      returns: returns
        .filter((ret) => ret.order?._id.toString() === sale._id.toString())
        .map((ret) => ({
          _id: ret._id,
          returnNumber: ret.returnNumber,
          status: ret.status,
          items: ret.items.map((item) => ({
            product: item.product?._id || item.product,
            productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
            productNameEn: item.product?.nameEn,
            quantity: item.quantity,
            reason: item.reason,
          })),
          reason: ret.reason,
          createdAt: new Date(ret.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
        })),
    }));

    console.log('جلب المبيعات - تم بنجاح:', {
      count: sales.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ sales: transformedSales, total, returns });
  } catch (err) {
    console.error('خطأ في جلب المبيعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Get sale by ID (محسن بـ transformed)
const getSaleById = async (req, res) => {
  const { id } = req.params;
  const { lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    if (!isValidObjectId(id)) {
      console.log('جلب بيع - معرف البيع غير صالح:', { id });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف البيع غير صالح' : 'Invalid sale ID' });
    }

    const sale = await Sale.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .lean();

    if (!sale) {
      console.log('جلب بيع - البيع غير موجود:', { id });
      return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
    }

    if (req.user.role === 'branch' && sale.branch?.toString() !== req.user.branchId?.toString()) {
      console.log('جلب بيع - غير مخول:', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى هذا البيع' : 'Unauthorized to access this sale' });
    }

    const returns = await Return.find({ order: id })
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn',
      })
      .lean();

    const transformedSale = {
      ...sale,
      orderNumber: sale.saleNumber,
      branch: sale.branch ? {
        ...sale.branch,
        displayName: isRtl ? (sale.branch.name || 'غير معروف') : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
      } : {
        displayName: isRtl ? 'غير معروف' : 'Unknown',
      },
      items: sale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      })),
      createdAt: new Date(sale.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      returns: returns.map((ret) => ({
        _id: ret._id,
        returnNumber: ret.returnNumber,
        status: ret.status,
        items: ret.items.map((item) => ({
          product: item.product?._id || item.product,
          productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          productNameEn: item.product?.nameEn,
          quantity: item.quantity,
          reason: item.reason,
        })),
        reason: ret.reason,
        createdAt: new Date(ret.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
      })),
    };

    console.log('جلب بيع - تم بنجاح:', { saleId: id, userId: req.user.id });

    res.status(200).json(transformedSale);
  } catch (err) {
    console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Update sale (محسن بـ lang و isRtl، و transformed)
const updateSale = async (req, res) => {
  const { id } = req.params;
  const { items, totalAmount, status, paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث البيع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    if (!isValidObjectId(id)) {
      console.log('تحديث البيع - معرف البيع غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف البيع غير صالح' : 'Invalid sale ID' });
    }

    const sale = await Sale.findById(id).session(session);
    if (!sale) {
      console.log('تحديث البيع - البيع غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
    }

    if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث البيع - غير مخول:', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث هذا البيع' : 'Unauthorized to update this sale' });
    }

    const oldStatus = sale.status;
    sale.items = items || sale.items;
    sale.totalAmount = totalAmount || sale.totalAmount;
    sale.status = status || sale.status;
    sale.paymentMethod = paymentMethod || sale.paymentMethod;
    sale.customerName = customerName?.trim() || sale.customerName;
    sale.customerPhone = customerPhone?.trim() || sale.customerPhone;
    sale.notes = notes?.trim() || sale.notes;

    await sale.save({ session });

    // If status changed to completed, deduct from inventory
    if (oldStatus !== 'completed' && sale.status === 'completed') {
      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: sale.branch },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `بيع #${sale.saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: sale.branch,
          action: 'sale',
          quantity: -item.quantity,
          reference: `بيع #${sale.saleNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: sale.branch.toString(),
          productId: item.product.toString(),
          quantity: inventory.currentStock,
          type: 'sale',
        });
      }
    } else if (oldStatus === 'completed' && sale.status !== 'completed') {
      // If status changed from completed, add back to inventory
      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: sale.branch },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `إلغاء بيع #${sale.saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: sale.branch,
          action: 'sale_cancelled',
          quantity: item.quantity,
          reference: `إلغاء بيع #${sale.saleNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: sale.branch.toString(),
          productId: item.product.toString(),
          quantity: inventory.currentStock,
          type: 'sale_cancelled',
        });
      }
    }

    const populatedSale = await Sale.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // Transform for language
    populatedSale.branch.displayName = isRtl ? (populatedSale.branch?.name || 'غير معروف') : (populatedSale.branch?.nameEn || populatedSale.branch?.name || 'Unknown');
    populatedSale.items = populatedSale.items.map((item) => ({
      ...item,
      productName: item.product?.name || 'منتج محذوف',
      productNameEn: item.product?.nameEn,
      displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
      displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      department: item.product?.department
        ? {
            ...item.product.department,
            displayName: isRtl ? (item.product.department.name || 'غير معروف') : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
          }
        : undefined,
    }));

    req.io?.emit('saleUpdated', {
      saleId: id,
      branchId: sale.branch.toString(),
      status: sale.status,
    });

    console.log('تحديث البيع - تم بنجاح:', {
      saleId: id,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json(populatedSale);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث البيع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Delete sale (محسن بـ lang و isRtl)
const deleteSale = async (req, res) => {
  const { id } = req.params;
  const { lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    if (!isValidObjectId(id)) {
      console.log('حذف البيع - معرف البيع غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف البيع غير صالح' : 'Invalid sale ID' });
    }

    const sale = await Sale.findById(id).session(session);
    if (!sale) {
      console.log('حذف البيع - البيع غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
    }

    if (sale.status === 'completed') {
      // Add back to inventory if completed
      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: sale.branch },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `حذف بيع #${sale.saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: sale.branch,
          action: 'sale_deleted',
          quantity: item.quantity,
          reference: `حذف بيع #${sale.saleNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: sale.branch.toString(),
          productId: item.product.toString(),
          quantity: inventory.currentStock,
          type: 'sale_deleted',
        });
      }
    }

    await sale.deleteOne({ session });

    req.io?.emit('saleDeleted', {
      saleId: id,
      branchId: sale.branch.toString(),
    });

    console.log('حذف البيع - تم بنجاح:', {
      saleId: id,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, message: isRtl ? 'تم حذف البيع بنجاح' : 'Sale deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في حذف البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createSale,
  getSales,
  getSaleById,
  updateSale,
  deleteSale,
};