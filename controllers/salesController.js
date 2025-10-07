const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const Return = require('../models/Return');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const createSale = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const errors = validationResult(req);
    const { branch, items, paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
    const isRtl = lang === 'ar';

    if (!errors.isEmpty()) {
      console.error('إنشاء بيع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }

    // Validate branch access
    if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
    }

    // Verify branch exists
    const branchDoc = await Branch.findById(branch).session(session);
    if (!branchDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    // Validate inventory and products
    for (const item of items) {
      const product = await Product.findById(item.productId).session(session);
      if (!product) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
      }
      const inventory = await Inventory.findOne({ branch, product: item.productId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `الكمية غير كافية للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}`,
          error: 'insufficient_stock',
        });
      }
    }

    // Generate sale number
    const saleCount = await Sale.countDocuments().session(session);
    const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;

    // Create sale
    const newSale = new Sale({
      saleNumber,
      branch,
      items: items.map((item) => ({
        product: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      totalAmount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
      status: 'completed',
      paymentMethod: paymentMethod || 'cash',
      customerName: customerName?.trim(),
      customerPhone: customerPhone?.trim(),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await newSale.save({ session });

    // Update inventory and history
    for (const item of items) {
      const inventory = await Inventory.findOneAndUpdate(
        { branch, product: item.productId },
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
        { new: true, session }
      );

      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch,
        action: 'sale',
        quantity: -item.quantity,
        reference: `بيع #${saleNumber}`,
        referenceType: 'sale',
        referenceId: newSale._id,
        createdBy: req.user.id,
        notes: notes?.trim(),
      });
      await historyEntry.save({ session });

      req.io?.emit('inventoryUpdated', {
        branchId: branch,
        productId: item.productId,
        quantity: inventory.currentStock,
        type: 'sale',
      });
    }

    const populatedSale = await Sale.findById(newSale._id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    populatedSale.branch.displayName = isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name);
    populatedSale.items = populatedSale.items.map((item) => ({
      ...item,
      productName: item.product?.name || 'منتج محذوف',
      productNameEn: item.product?.nameEn,
      displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
      displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      department: item.product?.department
        ? {
            ...item.product.department,
            displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
          }
        : undefined,
    }));

    req.io?.emit('saleCreated', {
      saleId: newSale._id,
      branchId: branch,
      saleNumber,
      items,
      totalAmount: newSale.totalAmount,
      createdAt: newSale.createdAt,
    });

    await session.commitTransaction();
    res.status(201).json(populatedSale);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء المبيعة:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getSales = async (req, res) => {
  try {
    const { branch, startDate, endDate, page = 1, limit = 20, sort = '-createdAt', lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        return res.status(400).json({ success: false, message: isRtl ? 'لا يوجد فرع مخصص' : 'No branch assigned' });
      }
      query.branch = req.user.branchId;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const total = await Sale.countDocuments(query);
    const sales = await Sale.find(query)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

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
      branch: {
        ...sale.branch,
        displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
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

    res.json({ sales: transformedSales, total });
  } catch (err) {
    console.error('خطأ في جلب المبيعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getSaleById = async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
    }

    const sale = await Sale.findById(id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username')
      .lean();

    if (!sale) {
      return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
    }

    if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId?.toString()) {
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
      branch: {
        ...sale.branch,
        displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
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

    res.json(transformedSale);
  } catch (err) {
    console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const deleteSale = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
    }

    const sale = await Sale.findById(id).session(session);
    if (!sale) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
    }

    if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى هذا البيع' : 'Unauthorized to access this sale' });
    }

    // Restore inventory
    for (const item of sale.items) {
      const inventory = await Inventory.findOneAndUpdate(
        { branch: sale.branch, product: item.product },
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
        { new: true, session }
      );

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: sale.branch,
        action: 'sale_cancelled',
        quantity: item.quantity,
        reference: `إلغاء بيع #${sale.saleNumber}`,
        referenceType: 'sale',
        referenceId: sale._id,
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

    await Sale.deleteOne({ _id: id }).session(session);
    req.io?.emit('saleDeleted', { saleId: id, branchId: sale.branch.toString() });

    await session.commitTransaction();
    res.json({ success: true, message: isRtl ? 'تم حذف البيع بنجاح' : 'Sale deleted successfully' });
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
  deleteSale,
};