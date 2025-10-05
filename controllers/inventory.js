const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper function to handle translations based on language
const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب المخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branch, product, lowStock, page = 1, limit = 10, lang = 'ar' } = req.query;
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المخزون - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [inventoryItems, totalItems] = await Promise.all([
      Inventory.find(query)
        .populate({
          path: 'product',
          select: 'name nameEn price unit unitEn department',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments(query),
    ]);

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    const formattedItems = filteredItems.map(item => ({
      ...item,
      product: item.product
        ? {
            _id: item.product._id,
            name: translateField(item.product, 'name', lang),
            nameEn: item.product.nameEn || item.product.name,
            price: item.product.price,
            unit: translateField(item.product, 'unit', lang),
            unitEn: item.product.unitEn || item.product.unit || 'N/A',
            department: item.product.department
              ? {
                  _id: item.product.department._id,
                  name: translateField(item.product.department, 'name', lang),
                  nameEn: item.product.department.nameEn || item.product.department.name,
                }
              : null,
          }
        : null,
      branch: {
        _id: item.branch._id,
        name: translateField(item.branch, 'name', lang),
        nameEn: item.branch.nameEn || item.branch.name,
      },
    }));

    console.log('جلب المخزون - تم بنجاح:', {
      count: filteredItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({
      success: true,
      inventory: formattedItems,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب المخزون حسب الفرع - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId } = req.params;
    const { page = 1, limit = 10, search, lowStock, lang = 'ar' } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }

    const query = { branch: branchId };
    if (search) {
      const products = await Product.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { nameEn: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
        ],
      }).select('_id');
      query.product = { $in: products.map(p => p._id) };
    }

    if (lowStock === 'true') {
      const inventory = await Inventory.aggregate([
        { $match: { branch: new mongoose.Types.ObjectId(branchId) } },
        { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $lookup: { from: 'departments', localField: 'product.department', foreignField: '_id', as: 'product.department' } },
        { $unwind: { path: '$product.department', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'branches', localField: 'branch', foreignField: '_id', as: 'branch' } },
        { $unwind: '$branch' },
        { $match: { $expr: { $lte: ['$currentStock', '$minStockLevel'] } } },
        { $skip: (parseInt(page) - 1) * parseInt(limit) },
        { $limit: parseInt(limit) },
        {
          $project: {
            product: { _id: 1, name: 1, nameEn: 1, price: 1, unit: 1, unitEn: 1, department: { _id: 1, name: 1, nameEn: 1 } },
            branch: { _id: 1, name: 1, nameEn: 1 },
            currentStock: 1,
            minStockLevel: 1,
            maxStockLevel: 1,
            damagedStock: 1,
          },
        },
      ]);

      const formattedInventory = inventory.map(item => ({
        ...item,
        product: item.product
          ? {
              _id: item.product._id,
              name: translateField(item.product, 'name', lang),
              nameEn: item.product.nameEn || item.product.name,
              price: item.product.price,
              unit: translateField(item.product, 'unit', lang),
              unitEn: item.product.unitEn || item.product.unit || 'N/A',
              department: item.product.department
                ? {
                    _id: item.product.department._id,
                    name: translateField(item.product.department, 'name', lang),
                    nameEn: item.product.department.nameEn || item.product.department.name,
                  }
                : null,
            }
          : null,
        branch: {
          _id: item.branch._id,
          name: translateField(item.branch, 'name', lang),
          nameEn: item.branch.nameEn || item.branch.name,
        },
      }));

      const total = await Inventory.countDocuments({ branch: branchId, $expr: { $lte: ['$currentStock', '$minStockLevel'] } });
      console.log('جلب المخزون حسب الفرع (lowStock) - تم بنجاح:', { count: inventory.length, branchId, userId: req.user.id });
      return res.status(200).json({
        success: true,
        inventory: formattedInventory,
        totalPages: Math.ceil(total / parseInt(limit)),
        currentPage: parseInt(page),
      });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [inventoryItems, totalItems] = await Promise.all([
      Inventory.find(query)
        .populate({
          path: 'product',
          select: 'name nameEn price unit unitEn department',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments(query),
    ]);

    const formattedItems = inventoryItems.map(item => ({
      ...item,
      product: item.product
        ? {
            _id: item.product._id,
            name: translateField(item.product, 'name', lang),
            nameEn: item.product.nameEn || item.product.name,
            price: item.product.price,
            unit: translateField(item.product, 'unit', lang),
            unitEn: item.product.unitEn || item.product.unit || 'N/A',
            department: item.product.department
              ? {
                  _id: item.product.department._id,
                  name: translateField(item.product.department, 'name', lang),
                  nameEn: item.product.department.nameEn || item.product.department.name,
                }
              : null,
          }
        : null,
      branch: {
        _id: item.branch._id,
        name: translateField(item.branch, 'name', lang),
        nameEn: item.branch.nameEn || item.branch.name,
      },
    }));

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      inventory: formattedItems,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب المخزون حسب الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب سجل المخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, page = 1, limit = 10, lang = 'ar' } = req.query;
    const query = {};

    if (branchId && isValidObjectId(branchId)) query.branch = branchId;
    if (productId && isValidObjectId(productId)) query.product = productId;

    if (req.user.role === 'branch' && branchId && branchId !== req.user.branchId?.toString()) {
      console.log('جلب سجل المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى سجل مخزون هذا الفرع' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [historyItems, totalItems] = await Promise.all([
      InventoryHistory.find(query)
        .populate('product', 'name nameEn unit unitEn')
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      InventoryHistory.countDocuments(query),
    ]);

    const formattedHistory = historyItems.map(item => ({
      ...item,
      product: item.product
        ? {
            _id: item.product._id,
            name: translateField(item.product, 'name', lang),
            nameEn: item.product.nameEn || item.product.name,
            unit: translateField(item.product, 'unit', lang),
            unitEn: item.product.unitEn || item.product.unit || 'N/A',
          }
        : null,
      branch: {
        _id: item.branch._id,
        name: translateField(item.branch, 'name', lang),
        nameEn: item.branch.nameEn || item.branch.name,
      },
      createdBy: {
        _id: item.createdBy._id,
        name: translateField(item.createdBy, 'name', lang),
        nameEn: item.createdBy.nameEn || item.createdBy.name,
      },
    }));

    console.log('جلب سجل المخزون - تم بنجاح:', {
      count: historyItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({
      success: true,
      history: formattedHistory,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get product details
const getProductDetails = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب تفاصيل المنتج - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId } = req.params;
    const { page = 1, limit = 10, lang = 'ar' } = req.query;

    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log('جلب تفاصيل المنتج - معرفات غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب تفاصيل المنتج - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى تفاصيل هذا الفرع' });
    }

    const [product, inventory, branch, historyItems, totalItems, returns] = await Promise.all([
      Product.findById(productId)
        .populate('department', 'name nameEn')
        .lean(),
      Inventory.findOne({ product: productId, branch: branchId })
        .populate({
          path: 'product',
          select: 'name nameEn price unit unitEn department',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .lean(),
      Branch.findById(branchId).lean(),
      InventoryHistory.find({ product: productId, branch: branchId })
        .populate('product', 'name nameEn unit unitEn')
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean(),
      InventoryHistory.countDocuments({ product: productId, branch: branchId }),
      Return.find({ 'items.product': productId, branch: branchId })
        .populate('branch', 'name nameEn')
        .populate({ path: 'items.product', select: 'name nameEn unit unitEn' })
        .lean(),
    ]);

    if (!product) {
      console.log('جلب تفاصيل المنتج - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log('جلب تفاصيل المنتج - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    const movements = historyItems.filter(item => ['restock', 'adjustment', 'return'].includes(item.action));
    const formattedMovements = movements.map(item => ({
      ...item,
      product: item.product
        ? {
            _id: item.product._id,
            name: translateField(item.product, 'name', lang),
            nameEn: item.product.nameEn || item.product.name,
            unit: translateField(item.product, 'unit', lang),
            unitEn: item.product.unitEn || item.product.unit || 'N/A',
          }
        : null,
      branch: {
        _id: item.branch._id,
        name: translateField(item.branch, 'name', lang),
        nameEn: item.branch.nameEn || item.branch.name,
      },
      createdBy: {
        _id: item.createdBy._id,
        name: translateField(item.createdBy, 'name', lang),
        nameEn: item.createdBy.nameEn || item.createdBy.name,
      },
    }));

    const formattedReturns = returns.map(ret => ({
      ...ret,
      branch: {
        _id: ret.branch._id,
        name: translateField(ret.branch, 'name', lang),
        nameEn: ret.branch.nameEn || ret.branch.name,
      },
      items: ret.items.map(item => ({
        ...item,
        product: {
          _id: item.product._id,
          name: translateField(item.product, 'name', lang),
          nameEn: item.product.nameEn || item.product.name,
          unit: translateField(item.product, 'unit', lang),
          unitEn: item.product.unitEn || item.product.unit || 'N/A',
        },
      })),
    }));

    const totalRestocks = historyItems
      .filter(item => item.action === 'restock')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalAdjustments = historyItems
      .filter(item => item.action === 'adjustment')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalReturns = returns
      .reduce((sum, ret) => sum + ret.items.reduce((acc, item) => acc + item.quantity, 0), 0);

    const statistics = {
      totalRestocks,
      totalAdjustments,
      totalReturns,
      averageStockLevel: inventory ? Math.round((inventory.currentStock / (inventory.maxStockLevel || 1)) * 100) : 0,
      lowStockStatus: inventory && inventory.currentStock <= inventory.minStockLevel,
    };

    const formattedProduct = {
      _id: product._id,
      name: translateField(product, 'name', lang),
      nameEn: product.nameEn || product.name,
      price: product.price,
      unit: translateField(product, 'unit', lang),
      unitEn: product.unitEn || product.unit || 'N/A',
      department: product.department
        ? {
            _id: product.department._id,
            name: translateField(product.department, 'name', lang),
            nameEn: product.department.nameEn || product.department.name,
          }
        : null,
    };

    const formattedInventory = inventory
      ? {
          ...inventory,
          product: inventory.product
            ? {
                _id: inventory.product._id,
                name: translateField(inventory.product, 'name', lang),
                nameEn: inventory.product.nameEn || inventory.product.name,
                price: inventory.product.price,
                unit: translateField(inventory.product, 'unit', lang),
                unitEn: inventory.product.unitEn || inventory.product.unit || 'N/A',
                department: inventory.product.department
                  ? {
                      _id: inventory.product.department._id,
                      name: translateField(inventory.product.department, 'name', lang),
                      nameEn: inventory.product.department.nameEn || inventory.product.department.name,
                    }
                  : null,
              }
            : null,
          branch: {
            _id: inventory.branch._id,
            name: translateField(inventory.branch, 'name', lang),
            nameEn: inventory.branch.nameEn || inventory.branch.name,
          },
        }
      : null;

    console.log('جلب تفاصيل المنتج - تم بنجاح:', {
      productId,
      branchId,
      userId: req.user.id,
      movementsCount: movements.length,
    });

    res.status(200).json({
      success: true,
      product: formattedProduct,
      inventory: formattedInventory,
      movements: formattedMovements,
      returns: formattedReturns,
      statistics,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب تفاصيل المنتج:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get returnable orders for product
const getReturnableOrdersForProduct = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب الطلبات القابلة للإرجاع - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId } = req.params;
    const { lang = 'ar' } = req.query;

    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log('جلب الطلبات القابلة للإرجاع - معرفات غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب الطلبات القابلة للإرجاع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى طلبات هذا الفرع' });
    }

    const orders = await Order.find({
      branch: branchId,
      'items.product': productId,
      status: { $in: ['delivered', 'completed'] },
    })
      .select('orderNumber items')
      .lean();

    const returnableOrders = orders
      .map(order => {
        const item = order.items.find(i => i.product.toString() === productId);
        if (!item) return null;
        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          remainingQuantity: item.quantity - (item.returnedQuantity || 0),
        };
      })
      .filter(order => order && order.remainingQuantity > 0);

    console.log('جلب الطلبات القابلة للإرجاع - تم بنجاح:', {
      productId,
      branchId,
      userId: req.user.id,
      count: returnableOrders.length,
    });

    res.status(200).json({ success: true, orders: returnableOrders });
  } catch (err) {
    console.error('خطأ في جلب الطلبات القابلة للإرجاع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get product history
const getProductHistory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب سجل المنتج - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId } = req.params;
    const { page = 1, limit = 10, lang = 'ar' } = req.query;

    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log('جلب سجل المنتج - معرفات غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب سجل المنتج - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى سجل هذا الفرع' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [historyItems, totalItems] = await Promise.all([
      InventoryHistory.find({ product: productId, branch: branchId })
        .populate('product', 'name nameEn unit unitEn')
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      InventoryHistory.countDocuments({ product: productId, branch: branchId }),
    ]);

    const formattedHistory = historyItems.map(item => ({
      ...item,
      product: item.product
        ? {
            _id: item.product._id,
            name: translateField(item.product, 'name', lang),
            nameEn: item.product.nameEn || item.product.name,
            unit: translateField(item.product, 'unit', lang),
            unitEn: item.product.unitEn || item.product.unit || 'N/A',
          }
        : null,
      branch: {
        _id: item.branch._id,
        name: translateField(item.branch, 'name', lang),
        nameEn: item.branch.nameEn || item.branch.name,
      },
      createdBy: {
        _id: item.createdBy._id,
        name: translateField(item.createdBy, 'name', lang),
        nameEn: item.createdBy.nameEn || item.createdBy.name,
      },
    }));

    console.log('جلب سجل المنتج - تم بنجاح:', {
      productId,
      branchId,
      userId: req.user.id,
      count: historyItems.length,
    });

    res.status(200).json({
      success: true,
      history: formattedHistory,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب سجل المنتج:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  getInventory,
  getInventoryByBranch,
  getInventoryHistory,
  getProductDetails,
  getReturnableOrdersForProduct,
  getProductHistory,
};