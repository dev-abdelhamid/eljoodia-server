// controllers/sales.js
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create a sale
const createSale = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء بيع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { items, totalAmount, status = 'completed', paymentMethod = 'cash', customerName, customerPhone, notes } = req.body;
    const branchId = req.user.branchId;

    if (!isValidObjectId(branchId)) {
      console.log('إنشاء بيع - معرف الفرع غير صالح:', { branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    // Validate items
    for (const item of items) {
      if (!isValidObjectId(item.product) || item.quantity < 1 || item.unitPrice < 0) {
        console.log('إنشاء بيع - عنصر غير صالح:', { product: item.product, quantity: item.quantity, unitPrice: item.unitPrice });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }
      const inventory = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء بيع - الكمية غير كافية:', { product: item.product, currentStock: inventory?.currentStock, requestedQuantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.product}` });
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all sales
const getSales = async (req, res) => {
  try {
    const { branch, page = 1, limit = 10, status, startDate, endDate } = req.query;
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المبيعات - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    if (status) query.status = status;
    if (startDate) query.createdAt = { $gte: new Date(startDate) };
    if (endDate) query.createdAt = { ...query.createdAt, $lte: new Date(endDate) };

    const sales = await Sale.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    const total = await Sale.countDocuments(query);

    console.log('جلب المبيعات - تم بنجاح:', {
      count: sales.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ sales, total });
  } catch (err) {
    console.error('خطأ في جلب المبيعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get sale by ID
const getSaleById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      console.log('جلب بيع - معرف البيع غير صالح:', { id });
      return res.status(400).json({ success: false, message: 'معرف البيع غير صالح' });
    }

    const sale = await Sale.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .lean();

    if (!sale) {
      console.log('جلب بيع - البيع غير موجود:', { id });
      return res.status(404).json({ success: false, message: 'البيع غير موجود' });
    }

    if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
      console.log('جلب بيع - غير مخول:', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى هذا البيع' });
    }

    console.log('جلب بيع - تم بنجاح:', { saleId: id, userId: req.user.id });

    res.status(200).json(sale);
  } catch (err) {
    console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update sale
const updateSale = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث البيع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { items, totalAmount, status, paymentMethod, customerName, customerPhone, notes } = req.body;

    if (!isValidObjectId(id)) {
      console.log('تحديث البيع - معرف البيع غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف البيع غير صالح' });
    }

    const sale = await Sale.findById(id).session(session);
    if (!sale) {
      console.log('تحديث البيع - البيع غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'البيع غير موجود' });
    }

    if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث البيع - غير مخول:', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذا البيع' });
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Delete sale
const deleteSale = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      console.log('حذف البيع - معرف البيع غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف البيع غير صالح' });
    }

    const sale = await Sale.findById(id).session(session);
    if (!sale) {
      console.log('حذف البيع - البيع غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'البيع غير موجود' });
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
    res.status(200).json({ success: true, message: 'تم حذف البيع بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في حذف البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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