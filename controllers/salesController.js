const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const createSale = async (req, res) => {
  try {
    const { items, paymentMethod, customerName, customerPhone, notes } = req.body;
    const branchId = req.user.role === 'branch' ? req.user.branchId : req.body.branch;

    if (!branchId || !isValidObjectId(branchId)) {
      console.log('إنشاء بيع - معرف الفرع غير صالح:', { branchId, userBranchId: req.user.branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.log('إنشاء بيع - مصفوفة العناصر غير صالحة:', { items });
      return res.status(400).json({ success: false, message: 'مصفوفة العناصر مطلوبة ويجب ألا تكون فارغة' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.productId) || !item.quantity || item.quantity < 1 || !item.unitPrice || item.unitPrice < 0) {
        console.log('إنشاء بيع - بيانات العنصر غير صالحة:', { productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice });
        return res.status(400).json({ success: false, message: `بيانات العنصر غير صالحة: ${item.productId}` });
      }
    }

    const branch = await Branch.findById(branchId);
    if (!branch) {
      console.log('إنشاء بيع - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('إنشاء بيع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء بيع لهذا الفرع' });
    }

    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) {
        console.log('إنشاء بيع - المنتج غير موجود:', { productId: item.productId });
        return res.status(404).json({ success: false, message: `المنتج ${item.productId} غير موجود` });
      }

      const inventory = await Inventory.findOne({ product: item.productId, branch: branchId });
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء بيع - الكمية غير كافية في المخزون:', {
          productId: item.productId,
          currentStock: inventory?.currentStock,
          requestedQuantity: item.quantity,
        });
        return res.status(400).json({ success: false, message: `الكمية غير كافية في المخزون للمنتج ${item.productId}` });
      }
    }

    const saleNumber = `SALE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newSale = new Sale({
      saleNumber,
      branch: branchId,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      paymentMethod: paymentMethod || 'cash',
      customerName: customerName?.trim(),
      customerPhone: customerPhone?.trim(),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await newSale.save();

    for (const item of items) {
      await Inventory.findOneAndUpdate(
        { product: item.productId, branch: branchId },
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
        { new: true }
      );
    }

    const populatedSale = await Sale.findById(newSale._id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .lean();

    req.io?.emit('saleCreated', {
      saleId: newSale._id,
      branchId,
      items: items.map(item => ({ productId: item.productId, quantity: item.quantity })),
    });

    console.log('إنشاء بيع - تم بنجاح:', {
      saleId: newSale._id,
      branchId,
      itemsCount: items.length,
    });

    res.status(201).json(populatedSale);
  } catch (err) {
    console.error('خطأ في إنشاء البيع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getSales = async (req, res) => {
  try {
    const { branch, startDate, endDate, page = 1, limit = 10 } = req.query;
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المبيعات - معرف الفرع غير صالح للمستخدم:', {
          userId: req.user.id,
          branchId: req.user.branchId,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const sales = await Sale.find(query)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Sale.countDocuments(query);

    console.log('جلب المبيعات - تم جلب المبيعات:', {
      count: sales.length,
      total,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ sales, total });
  } catch (err) {
    console.error('خطأ في جلب المبيعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getSaleById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.log('جلب البيع - معرف البيع غير صالح:', id);
      return res.status(400).json({ success: false, message: 'معرف البيع غير صالح' });
    }

    const sale = await Sale.findById(id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .lean();

    if (!sale) {
      console.log('جلب البيع - البيع غير موجود:', id);
      return res.status(404).json({ success: false, message: 'البيع غير موجود' });
    }

    if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId.toString()) {
      console.log('جلب البيع - غير مخول:', {
        userId: req.user.id,
        branchId: sale.branch._id,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى هذا البيع' });
    }

    console.log('جلب البيع - تم بنجاح:', { saleId: id, userId: req.user.id });

    res.status(200).json(sale);
  } catch (err) {
    console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  createSale,
  getSales,
  getSaleById,
};