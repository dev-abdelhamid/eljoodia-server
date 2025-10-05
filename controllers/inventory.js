const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Order = require('../models/Order');
const InventoryHistory = require('../models/InventoryHistory');
const Transfer = require('../models/Transfer');
const Return = require('../models/Return');
const mongoose = require('mongoose');

// Helper function to handle translations based on language
const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

// Get all inventory items (admin or branch-specific)
const getInventory = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { branch, product, lowStock, page = 1, limit = 10, lang = 'en' } = req.query;
    const query = {};
    if (branch) query.branch = branch;
    if (product) query.product = product;
    if (lowStock === 'true') query.currentStock = { $lte: mongoose.mongo.eval('$minStockLevel') };

    const skip = (page - 1) * limit;
    const inventory = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalItems = await Inventory.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    const formattedInventory = inventory.map(item => ({
      ...item,
      product: item.product
        ? {
            _id: item.product._id,
            name: translateField(item.product, 'name', lang),
            nameEn: item.product.nameEn || item.product.name,
            code: item.product.code || 'N/A',
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

    console.log(`[${new Date().toISOString()}] Fetched inventory:`, { count: formattedInventory.length, page, totalPages });
    res.status(200).json({ inventory: formattedInventory, totalPages, currentPage: parseInt(page) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching inventory:`, error);
    next(error);
  }
};

// Get inventory by branch ID with pagination and search
const getInventoryByBranch = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { branchId } = req.params;
    const { page = 1, limit = 10, search, lowStock, lang = 'en' } = req.query;
    const query = { branch: branchId };
    if (search) {
      query.$or = [
        { 'product.name': { $regex: search, $options: 'i' } },
        { 'product.nameEn': { $regex: search, $options: 'i' } },
        { 'product.code': { $regex: search, $options: 'i' } },
      ];
    }
    if (lowStock === 'true') query.currentStock = { $lte: mongoose.mongo.eval('$minStockLevel') };

    const skip = (page - 1) * limit;
    const inventory = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalItems = await Inventory.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    const formattedInventory = inventory.map(item => ({
      ...item,
      product: item.product
        ? {
            _id: item.product._id,
            name: translateField(item.product, 'name', lang),
            nameEn: item.product.nameEn || item.product.name,
            code: item.product.code || 'N/A',
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

    console.log(`[${new Date().toISOString()}] Fetched inventory for branch ${branchId}:`, { count: formattedInventory.length, page, totalPages });
    res.status(200).json({ inventory: formattedInventory, totalPages, currentPage: parseInt(page) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching inventory by branch:`, error);
    next(error);
  }
};

// Get inventory history
const getInventoryHistory = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { branchId, productId, page = 1, limit = 10, lang = 'en' } = req.query;
    const query = {};
    if (branchId) query.branch = branchId;
    if (productId) query.product = productId;

    const skip = (page - 1) * limit;
    const history = await InventoryHistory.find(query)
      .populate('product', 'name nameEn unit unitEn')
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'name nameEn')
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalItems = await InventoryHistory.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    const formattedHistory = history.map(item => ({
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

    console.log(`[${new Date().toISOString()}] Fetched inventory history:`, { count: formattedHistory.length, page, totalPages });
    res.status(200).json({ history: formattedHistory, totalPages, currentPage: parseInt(page) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching inventory history:`, error);
    next(error);
  }
};

// Get product details, movements, transfers, and statistics
const getProductDetails = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { productId, branchId } = req.params;
    const { page = 1, limit = 10, lang = 'en' } = req.query;

    const product = await Product.findById(productId)
      .populate('department', 'name nameEn')
      .lean();
    if (!product) {
      return res.status(404).json({ message: lang === 'ar' ? 'المنتج غير موجود' : 'Product not found' });
    }

    const inventory = await Inventory.findOne({ product: productId, branch: branchId })
      .populate('product', 'name nameEn unit unitEn department')
      .populate('branch', 'name nameEn')
      .lean();

    const movements = await InventoryHistory.find({ product: productId, branch: branchId })
      .populate('product', 'name nameEn')
      .populate('branch', 'name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const transfers = await Transfer.find({
      product: productId,
      $or: [{ fromBranch: branchId }, { toBranch: branchId }],
    })
      .populate('product', 'name nameEn')
      .populate('fromBranch', 'name nameEn')
      .populate('toBranch', 'name nameEn')
      .lean();

    const returns = await Return.find({ branch: branchId, 'items.product': productId })
      .populate('branch', 'name nameEn')
      .lean();

    const totalRestocks = await InventoryHistory.countDocuments({ product: productId, branch: branchId, action: 'restock' });
    const totalAdjustments = await InventoryHistory.countDocuments({ product: productId, branch: branchId, action: 'adjustment' });
    const totalReturns = await Return.countDocuments({ branch: branchId, 'items.product': productId });
    const totalTransfersIn = await Transfer.countDocuments({ product: productId, toBranch: branchId });
    const totalTransfersOut = await Transfer.countDocuments({ product: productId, fromBranch: branchId });

    const formattedProduct = {
      _id: product._id,
      name: translateField(product, 'name', lang),
      nameEn: product.nameEn || product.name,
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

    const formattedMovements = movements.map(m => ({
      ...m,
      product: m.product
        ? {
            _id: m.product._id,
            name: translateField(m.product, 'name', lang),
            nameEn: m.product.nameEn || m.product.name,
          }
        : null,
      branch: {
        _id: m.branch._id,
        name: translateField(m.branch, 'name', lang),
        nameEn: m.branch.nameEn || m.branch.name,
      },
    }));

    const formattedTransfers = transfers.map(t => ({
      ...t,
      product: t.product
        ? {
            _id: t.product._id,
            name: translateField(t.product, 'name', lang),
            nameEn: t.product.nameEn || t.product.name,
          }
        : null,
      fromBranchName: t.fromBranch ? translateField(t.fromBranch, 'name', lang) : 'N/A',
      toBranchName: t.toBranch ? translateField(t.toBranch, 'name', lang) : 'N/A',
    }));

    const formattedReturns = returns.map(r => ({
      ...r,
      branchName: r.branch ? translateField(r.branch, 'name', lang) : 'N/A',
      items: r.items.map(item => ({
        productName: item.product ? translateField(item.product, 'name', lang) : 'N/A',
        quantity: item.quantity,
        unit: item.unit ? translateField({ unit: item.unit, unitEn: item.unitEn }, 'unit', lang) : 'N/A',
      })),
    }));

    const statistics = {
      totalRestocks,
      totalAdjustments,
      totalReturns,
      totalTransfersIn,
      totalTransfersOut,
      averageStockLevel: inventory ? inventory.currentStock : 0,
      lowStockStatus: inventory ? inventory.currentStock <= inventory.minStockLevel : false,
    };

    console.log(`[${new Date().toISOString()}] Fetched product details for product ${productId} in branch ${branchId}`);
    res.status(200).json({
      product: formattedProduct,
      inventory: formattedInventory,
      movements: formattedMovements,
      transfers: formattedTransfers,
      returns: formattedReturns,
      statistics,
      totalPages: Math.ceil(movements.length / limit),
      currentPage: parseInt(page),
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching product details:`, error);
    next(error);
  }
};

// Get returnable orders for product
const getReturnableOrdersForProduct = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { productId, branchId } = req.params;
    const { lang = 'en' } = req.query;

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

    console.log(`[${new Date().toISOString()}] Fetched returnable orders for product ${productId} in branch ${branchId}:`, returnableOrders);
    res.status(200).json({ orders: returnableOrders });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching returnable orders:`, error);
    next(error);
  }
};

// Get product history
const getProductHistory = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { productId, branchId } = req.params;
    const { page = 1, limit = 10, lang = 'en' } = req.query;

    const history = await InventoryHistory.find({ product: productId, branch: branchId })
      .populate('product', 'name nameEn unit unitEn')
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const totalItems = await InventoryHistory.countDocuments({ product: productId, branch: branchId });
    const totalPages = Math.ceil(totalItems / limit);

    const formattedHistory = history.map(item => ({
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

    console.log(`[${new Date().toISOString()}] Fetched product history for product ${productId} in branch ${branchId}:`, { count: formattedHistory.length, page, totalPages });
    res.status(200).json({ history: formattedHistory, totalPages, currentPage: parseInt(page) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching product history:`, error);
    next(error);
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