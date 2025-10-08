const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper function to transform sale data based on language
const transformSaleData = (sale, isRtl) => ({
  ...sale,
  orderNumber: sale.saleNumber,
  branch: sale.branch
    ? {
        ...sale.branch,
        displayName: isRtl ? (sale.branch.name || 'غير معروف') : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
      }
    : { displayName: isRtl ? 'غير معروف' : 'Unknown' },
  items: (sale.items || []).map((item) => ({
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
  returns: (sale.returns || []).map((ret) => ({
    _id: ret._id,
    returnNumber: ret.returnNumber,
    status: ret.status,
    items: (ret.items || []).map((item) => ({
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
});

// Common aggregation pipeline for sales analytics
const getSalesAnalytics = async (query, isRtl, limit = 10) => {
  const dateFormat = query.createdAt?.$gte && query.createdAt?.$lte && 
    (new Date(query.createdAt.$lte) - new Date(query.createdAt.$gte)) / (1000 * 60 * 60 * 24) > 30 ? 'month' : 'day';

  const totalSales = await Sale.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$totalAmount' },
        totalCount: { $sum: 1 },
      },
    },
  ]).catch(() => [{ totalSales: 0, totalCount: 0 }]);

  const branchSales = await Sale.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$branch',
        totalSales: { $sum: '$totalAmount' },
        saleCount: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'branches',
        localField: '_id',
        foreignField: '_id',
        as: 'branch',
      },
    },
    { $unwind: '$branch' },
    {
      $project: {
        branchId: '$_id',
        branchName: '$branch.name',
        branchNameEn: '$branch.nameEn',
        displayName: isRtl ? '$branch.name' : { $ifNull: ['$branch.nameEn', '$branch.name'] },
        totalSales: 1,
        saleCount: 1,
      },
    },
    { $sort: { totalSales: -1 } },
    { $limit },
  ]).catch(() => []);

  const productSales = await Sale.aggregate([
    { $match: query },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        totalQuantity: { $sum: '$items.quantity' },
        totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
      },
    },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { name: 1, nameEn: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        productId: '$_id',
        productName: { $ifNull: ['$product.name', 'منتج محذوف'] },
        productNameEn: '$product.nameEn',
        displayName: isRtl ? { $ifNull: ['$product.name', 'منتج محذوف'] } : { $ifNull: ['$product.nameEn', '$product.name', 'Deleted Product'] },
        totalQuantity: 1,
        totalRevenue: 1,
      },
    },
    { $sort: { totalQuantity: -1 } },
    { $limit },
  ]).catch(() => []);

  const salesTrends = await Sale.aggregate([
    { $match: query },
    {
      $group: {
        _id: {
          $dateToString: {
            format: dateFormat === 'month' ? '%Y-%m' : '%Y-%m-%d',
            date: '$createdAt',
          },
        },
        totalSales: { $sum: '$totalAmount' },
        saleCount: { $sum: 1 },
      },
    },
    {
      $project: {
        period: '$_id',
        totalSales: 1,
        saleCount: 1,
        _id: 0,
      },
    },
    { $sort: { period: 1 } },
  ]).catch(() => []);

  const topCustomers = await Sale.aggregate([
    { $match: { ...query, customerName: { $ne: null, $ne: '' } } },
    {
      $group: {
        _id: { name: '$customerName', phone: '$customerPhone' },
        totalSpent: { $sum: '$totalAmount' },
        purchaseCount: { $sum: 1 },
      },
    },
    {
      $project: {
        customerName: '$_id.name',
        customerPhone: '$_id.phone',
        totalSpent: 1,
        purchaseCount: 1,
        _id: 0,
      },
    },
    { $sort: { totalSpent: -1 } },
    { $limit: 5 },
  ]).catch(() => []);

  const returnStats = await Return.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalQuantity: { $sum: { $sum: '$items.quantity' } },
      },
    },
    {
      $project: {
        status: '$_id',
        count: 1,
        totalQuantity: 1,
        _id: 0,
      },
    },
  ]).catch(() => []);

  return {
    totalSales: totalSales[0]?.totalSales || 0,
    totalCount: totalSales[0]?.totalCount || 0,
    branchSales,
    productSales,
    salesTrends,
    topCustomers,
    returnStats,
    averageOrderValue: totalSales[0]?.totalCount ? (totalSales[0].totalSales / totalSales[0].totalCount).toFixed(2) : 0,
    returnRate: totalSales[0]?.totalCount ? ((returnStats.reduce((sum, stat) => sum + stat.count, 0) / totalSales[0].totalCount) * 100).toFixed(2) : 0,
    topProduct: productSales.length > 0 ? productSales[0] : {
      productId: null,
      productName: isRtl ? 'غير معروف' : 'Unknown',
      displayName: isRtl ? 'غير معروف' : 'Unknown',
      totalQuantity: 0,
      totalRevenue: 0,
    },
  };
};

// Create a sale
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

    // Validate items and check stock
    for (const item of items) {
      if (!isValidObjectId(item.product) || item.quantity < 1 || item.unitPrice < 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data' });
      }
      const inventory = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient stock for product ${item.product}` });
      }
      // Check minimum stock threshold
      if (inventory.currentStock - item.quantity < inventory.minStock) {
        req.io?.emit('lowStockWarning', {
          branchId,
          productId: item.product,
          currentStock: inventory.currentStock - item.quantity,
        });
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
          { session, new: true }
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

    const transformedSale = transformSaleData(populatedSale, isRtl);

    req.io?.emit('saleCreated', {
      saleId: sale._id,
      branchId,
      saleNumber,
      items,
      totalAmount: sale.totalAmount,
      createdAt: sale.createdAt,
    });

    console.log('إنشاء بيع - تم بنجاح:', {
      saleId: sale._id,
      branchId,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json(transformedSale);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء البيع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all sales
const getSales = async (req, res) => {
  const { branch, page = 1, limit = 10, status, startDate, endDate, lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
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
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn' })
      .lean();

    const transformedSales = sales.map((sale) => ({
      ...transformSaleData({ ...sale, returns: returns.filter((ret) => ret.order?._id.toString() === sale._id.toString()) }, isRtl),
    }));

    res.status(200).json({ sales: transformedSales, total });
  } catch (err) {
    console.error('خطأ في جلب المبيعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Get sale by ID
const getSaleById = async (req, res) => {
  const { id } = req.params;
  const { lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف البيع غير صالح' : 'Invalid sale ID' });
    }

    const sale = await Sale.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .lean();

    if (!sale) {
      return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
    }

    if (req.user.role === 'branch' && sale.branch?._id.toString() !== req.user.branchId?.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى هذا البيع' : 'Unauthorized to access this sale' });
    }

    const returns = await Return.find({ order: id })
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn' })
      .lean();

    const transformedSale = transformSaleData({ ...sale, returns }, isRtl);

    res.status(200).json(transformedSale);
  } catch (err) {
    console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Enhanced analytics endpoint for admin
const getAdminAnalytics = async (req, res) => {
  const { branch, startDate, endDate, paymentMethod, lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    }
    if (paymentMethod) {
      query.paymentMethod = paymentMethod;
    }

    const analytics = await getSalesAnalytics(query, isRtl);

    // Additional analytics: Sales by payment method
    const paymentMethodStats = await Sale.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$paymentMethod',
          totalSales: { $sum: '$totalAmount' },
          saleCount: { $sum: 1 },
        },
      },
      {
        $project: {
          paymentMethod: '$_id',
          totalSales: 1,
          saleCount: 1,
          _id: 0,
        },
      },
    ]).catch(() => []);

    // Sales by user (top performing employees)
    const userSales = await Sale.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$createdBy',
          totalSales: { $sum: '$totalAmount' },
          saleCount: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          userId: '$_id',
          username: '$user.username',
          totalSales: 1,
          saleCount: 1,
        },
      },
      { $sort: { totalSales: -1 } },
      { $limit: 5 },
    ]).catch(() => []);

    res.json({
      success: true,
      ...analytics,
      paymentMethodStats,
      userSales,
    });
  } catch (err) {
    console.error('خطأ في جلب إحصائيات الأدمن:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Branch analytics endpoint
const getBranchAnalytics = async (req, res) => {
  const { startDate, endDate, lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    if (req.user.role !== 'branch' || !req.user.branchId || !isValidObjectId(req.user.branchId)) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
    }

    const query = { branch: req.user.branchId };
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    }

    const analytics = await getSalesAnalytics(query, isRtl, 5);

    res.json({ success: true, ...analytics });
  } catch (err) {
    console.error('خطأ في جلب إحصائيات الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  createSale,
  getSales,
  getSaleById,
  getAdminAnalytics,
  getBranchAnalytics,
};