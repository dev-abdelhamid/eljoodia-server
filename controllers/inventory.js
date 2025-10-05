// controllers/inventoryController.js
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

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock, page = 1, limit = 10 } = req.query;
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
        .populate('product', 'name nameEn price unit unitEn department')
        .populate({ path: 'product.department', select: 'name nameEn' })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments(query),
    ]);

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    console.log('جلب المخزون - تم بنجاح:', {
      count: filteredItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({
      success: true,
      inventory: filteredItems,
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
    const { branchId } = req.params;
    const { page = 1, limit = 10, search, lowStock } = req.query;

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
        ],
      }).select('_id');
      query.product = { $in: products.map(p => p._id) };
    }
    if (lowStock === 'true') {
      // Use aggregation for lowStock filter since minStockLevel is per document
      const inventory = await Inventory.aggregate([
        { $match: { branch: new mongoose.Types.ObjectId(branchId) } },
        { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $lookup: { from: 'departments', localField: 'product.department', foreignField: '_id', as: 'product.department' } },
        { $unwind: { path: '$product.department', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'branches', localField: 'branch', foreignField : '_id', as: 'branch' } },
        { $unwind: '$branch' },
        { $match: { $expr: { $lte: ['$currentStock', '$minStockLevel'] } } },
        { $skip: skip },
        { $limit: parseInt(limit) },
        { $project: { 
          product: { _id: 1, name: 1, nameEn: 1, price: 1, unit: 1, unitEn: 1, department: { _id: 1, name: 1, nameEn: 1 } },
          branch: { _id: 1, name: 1, nameEn: 1 },
          currentStock: 1, minStockLevel: 1, maxStockLevel: 1, damagedStock: 1 
        } },
      ]);
      const total = await Inventory.countDocuments({ branch: branchId, $expr: { $lte: ['$currentStock', '$minStockLevel'] } });
      return res.status(200).json({
        success: true,
        inventory,
        totalPages: Math.ceil(total / parseInt(limit)),
        currentPage: parseInt(page),
      });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [inventoryItems, totalItems] = await Promise.all([
      Inventory.find(query)
        .populate('product', 'name nameEn price unit unitEn department')
        .populate({ path: 'product.department', select: 'name nameEn' })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments(query),
    ]);

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      inventory: inventoryItems,
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
    const { branchId, productId, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

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
      productName: isRtl ? item.product?.name : item.product?.nameEn,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      createdByName: isRtl ? item.createdBy?.name : item.createdBy?.nameEn,
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
    const { productId, branchId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log('جلب تفاصيل المنتج - معرفات غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب تفاصيل المنتج - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى تفاصيل هذا الفرع' });
    }

    const [product, inventory, branch, historyItems, totalItems, returns, transfers] = await Promise.all([
      Product.findById(productId)
        .populate('department', 'name nameEn')
        .lean(),
      Inventory.findOne({ product: productId, branch: branchId })
        .populate('product', 'name nameEn price unit unitEn department')
        .populate({ path: 'product.department', select: 'name nameEn' })
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
      InventoryHistory.find({ product: productId, branch: branchId, type: { $in: ['transfer_in', 'transfer_out'] } })
        .populate('transferDetails.fromBranch', 'name nameEn')
        .populate('transferDetails.toBranch', 'name nameEn')
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

    const movements = historyItems.filter(item => ['restock', 'adjustment', 'return'].includes(item.type));
    const formattedMovements = movements.map(item => ({
      ...item,
      productName: isRtl ? item.product?.name : item.product?.nameEn,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      createdByName: isRtl ? item.createdBy?.name : item.createdBy?.nameEn,
    }));
    const formattedTransfers = transfers.map(item => ({
      ...item,
      fromBranchName: item.transferDetails?.fromBranch ? (isRtl ? item.transferDetails.fromBranch.name : item.transferDetails.fromBranch.nameEn) : null,
      toBranchName: item.transferDetails?.toBranch ? (isRtl ? item.transferDetails.toBranch.name : item.transferDetails.toBranch.nameEn) : null,
    }));
    const formattedReturns = returns.map(ret => ({
      ...ret,
      branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn,
      items: ret.items.map(item => ({
        ...item,
        productName: isRtl ? item.product.name : item.product.nameEn,
        unit: isRtl ? item.product.unit : item.product.unitEn,
      })),
    }));

    // Calculate statistics
    const totalRestocks = historyItems
      .filter(item => item.type === 'restock')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalAdjustments = historyItems
      .filter(item => item.type === 'adjustment')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalReturns = returns
      .reduce((sum, ret) => sum + ret.items.reduce((acc, item) => acc + item.quantity, 0), 0);
    const totalTransfersIn = transfers
      .filter(item => item.type === 'transfer_in')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalTransfersOut = transfers
      .filter(item => item.type === 'transfer_out')
      .reduce((sum, item) => sum + item.quantity, 0);

    const statistics = {
      totalRestocks,
      totalAdjustments,
      totalReturns,
      totalTransfersIn,
      totalTransfersOut,
      averageStockLevel: inventory ? Math.round((inventory.currentStock / (inventory.maxStockLevel || 1)) * 100) : 0,
      lowStockStatus: inventory && inventory.currentStock <= inventory.minStockLevel,
    };

    console.log('جلب تفاصيل المنتج - تم بنجاح:', {
      productId,
      branchId,
      userId: req.user.id,
      movementsCount: movements.length,
      transfersCount: transfers.length,
    });

    res.status(200).json({
      success: true,
      product: {
        ...product,
        name: isRtl ? product.name : product.nameEn,
        unit: isRtl ? product.unit : product.unitEn,
        departmentName: isRtl ? product.department?.name : product.department?.nameEn,
      },
      inventory: inventory ? {
        ...inventory,
        productName: isRtl ? inventory.product?.name : inventory.product?.nameEn,
        branchName: isRtl ? inventory.branch?.name : inventory.branch?.nameEn,
        departmentName: isRtl ? inventory.product?.department?.name : inventory.product?.department?.nameEn,
      } : null,
      movements: formattedMovements,
      transfers: formattedTransfers,
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

module.exports = {
  getInventory,
  getInventoryByBranch,
  getInventoryHistory,
  getProductDetails,
};