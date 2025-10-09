const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const { updateInventoryStock } = require('../utils/inventoryUtils');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper function to handle translations based on language
const translateField = (item, field, isRtl) => {
  return isRtl ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

// Create or update inventory item
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] createInventory - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error',
      });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 10, maxStockLevel = 100, orderId } = req.body;
    const isRtl = req.query.lang === 'ar';

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      console.log(`[${new Date().toISOString()}] createInventory - Invalid inputs:`, { branchId, productId, userId, currentStock });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' : 'Invalid branch, product, user ID, or quantity',
      });
    }

    // Check user authorization
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] createInventory - User not found:`, { userId });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'المستخدم غير موجود' : 'User not found',
        error: 'errors.no_user',
      });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] createInventory - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch',
      });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log(`[${new Date().toISOString()}] createInventory - Product not found:`, { productId });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'المنتج غير موجود' : 'Product not found',
      });
    }
    if (!branch) {
      console.log(`[${new Date().toISOString()}] createInventory - Branch not found:`, { branchId });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الفرع غير موجود' : 'Branch not found',
      });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log(`[${new Date().toISOString()}] createInventory - Invalid order ID:`, { orderId });
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
        });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log(`[${new Date().toISOString()}] createInventory - Order not found:`, { orderId });
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        });
      }
      if (order.status !== 'delivered') {
        console.log(`[${new Date().toISOString()}] createInventory - Invalid order status:`, { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in "delivered" status',
        });
      }
    }

    const reference = orderId
      ? isRtl
        ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
        : `Order delivery confirmation #${orderId} by ${req.user.username}`
      : isRtl
      ? `إنشاء مخزون بواسطة ${req.user.username}`
      : `Inventory creation by ${req.user.username}`;

    // Create or update inventory using updateInventoryStock
    const inventory = await updateInventoryStock({
      branch: branchId,
      product: productId,
      quantity: currentStock,
      type: 'restock',
      reference,
      referenceType: orderId ? 'order' : 'adjustment',
      referenceId: orderId || null,
      createdBy: userId,
      session,
      isRtl,
    });

    // Check for low stock and emit notification
    if (inventory.currentStock <= inventory.minStockLevel) {
      req.io?.emit('lowStockWarning', {
        branchId,
        productId,
        productName: isRtl ? product.name : product.nameEn || product.name,
        currentStock: inventory.currentStock,
        minStockLevel: inventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }

    // Emit inventory update event
    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
    });

    // Populate response
    const populatedItem = await Inventory.findById(inventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    console.log(`[${new Date().toISOString()}] createInventory - Success:`, {
      inventoryId: inventory._id,
      productId,
      branchId,
      currentStock,
      minStockLevel,
      maxStockLevel,
      userId,
      orderId,
    });

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      inventory: populatedItem,
      message: isRtl ? 'تم إنشاء عنصر المخزون بنجاح' : 'Inventory item created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] createInventory - Error:`, {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// Bulk create or update inventory items
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] bulkCreate - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error',
      });
    }

    const { branchId, userId, orderId, items } = req.body;
    const isRtl = req.query.lang === 'ar';

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      console.log(`[${new Date().toISOString()}] bulkCreate - Invalid inputs:`, { branchId, userId, items });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الفرع، المستخدم، أو العناصر غير صالحة' : 'Invalid branch, user ID, or items',
      });
    }

    // Validate user
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] bulkCreate - User not found:`, { userId });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'المستخدم غير موجود' : 'User not found',
        error: 'errors.no_user',
      });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] bulkCreate - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch',
      });
    }

    // Validate branch
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log(`[${new Date().toISOString()}] bulkCreate - Branch not found:`, { branchId });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الفرع غير موجود' : 'Branch not found',
      });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log(`[${new Date().toISOString()}] bulkCreate - Invalid order ID:`, { orderId });
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
        });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log(`[${new Date().toISOString()}] bulkCreate - Order not found:`, { orderId });
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        });
      }
      if (order.status !== 'delivered') {
        console.log(`[${new Date().toISOString()}] bulkCreate - Invalid order status:`, { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in "delivered" status',
        });
      }
    }

    // Validate products
    const productIds = items.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      console.log(`[${new Date().toISOString()}] bulkCreate - Some products not found:`, { productIds });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found',
      });
    }

    const results = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 10, maxStockLevel = 100 } = item;

      if (!isValidObjectId(productId) || currentStock < 0) {
        console.log(`[${new Date().toISOString()}] bulkCreate - Invalid item data:`, { productId, currentStock });
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `بيانات غير صالحة للمنتج ${productId}` : `Invalid data for product ${productId}`,
        });
      }

      const product = products.find((p) => p._id.toString() === productId);
      if (!product) {
        console.log(`[${new Date().toISOString()}] bulkCreate - Product not found:`, { productId });
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          message: isRtl ? `المنتج ${productId} غير موجود` : `Product ${productId} not found`,
        });
      }

      const reference = orderId
        ? isRtl
          ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
          : `Order delivery confirmation #${orderId} by ${req.user.username}`
        : isRtl
        ? `إنشاء دفعة مخزون بواسطة ${req.user.username}`
        : `Bulk inventory creation by ${req.user.username}`;

      // Update inventory using updateInventoryStock
      const inventory = await updateInventoryStock({
        branch: branchId,
        product: productId,
        quantity: currentStock,
        type: 'restock',
        reference,
        referenceType: orderId ? 'order' : 'adjustment',
        referenceId: orderId || null,
        createdBy: userId,
        session,
        isRtl,
      });

      // Check for low stock
      if (inventory.currentStock <= inventory.minStockLevel) {
        req.io?.emit('lowStockWarning', {
          branchId,
          productId,
          productName: isRtl ? product.name : product.nameEn || product.name,
          currentStock: inventory.currentStock,
          minStockLevel: inventory.minStockLevel,
          timestamp: new Date().toISOString(),
        });
      }

      // Emit inventory update event
      req.io?.emit('inventoryUpdated', {
        branchId,
        productId,
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
      });

      results.push(inventory._id);
    }

    // Populate response
    const populatedItems = await Inventory.find({ _id: { $in: results } })
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    console.log(`[${new Date().toISOString()}] bulkCreate - Success:`, {
      branchId,
      userId,
      orderId,
      itemCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      inventories: populatedItems,
      message: isRtl ? 'تم إنشاء دفعة المخزون بنجاح' : 'Bulk inventory created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] bulkCreate - Error:`, {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// Get inventory for a specific branch
const getInventoryByBranch = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] getInventoryByBranch - Validation errors:`, errors.array());
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error',
      });
    }

    const { branchId } = req.params;
    const { department, stockStatus } = req.query;
    const isRtl = req.query.lang === 'ar';

    if (!isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] getInventoryByBranch - Invalid branch ID:`, { branchId });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID',
      });
    }

    // Check user authorization
    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] getInventoryByBranch - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لعرض مخزون هذا الفرع' : 'Not authorized to view inventory for this branch',
      });
    }

    // Validate branch
    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
      console.log(`[${new Date().toISOString()}] getInventoryByBranch - Branch not found:`, { branchId });
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الفرع غير موجود' : 'Branch not found',
      });
    }

    // Build query
    const query = { branch: branchId };
    if (department && isValidObjectId(department)) {
      query['product.department'] = department;
    }
    if (stockStatus) {
      const inventories = await Inventory.find({ branch: branchId }).lean();
      const filteredIds = inventories
        .filter((item) => {
          const isLow = item.currentStock <= item.minStockLevel;
          const isHigh = item.currentStock >= item.maxStockLevel;
          return stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
        })
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    }

    // Fetch inventory
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    if (!inventories.length) {
      console.log(`[${new Date().toISOString()}] getInventoryByBranch - No inventory found:`, { branchId, department, stockStatus });
      return res.status(200).json({
        success: true,
        inventory: [],
        message: isRtl ? 'لا توجد بيانات مخزون' : 'No inventory found',
      });
    }

    // Transform response
    const transformedInventories = inventories.map((item) => ({
      ...item,
      status:
        item.currentStock <= item.minStockLevel
          ? 'low'
          : item.currentStock >= item.maxStockLevel
          ? 'high'
          : 'normal',
      branch: {
        ...item.branch,
        displayName: translateField(item.branch, 'name', isRtl),
      },
      product: {
        ...item.product,
        displayName: translateField(item.product, 'name', isRtl),
        displayUnit: translateField(item.product, 'unit', isRtl),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: translateField(item.product.department, 'name', isRtl),
            }
          : null,
      },
      createdByDisplay: translateField(item.createdBy, 'name', isRtl),
      updatedByDisplay: translateField(item.updatedBy, 'name', isRtl),
    }));

    console.log(`[${new Date().toISOString()}] getInventoryByBranch - Success:`, { branchId, itemCount: inventories.length });
    res.status(200).json({
      success: true,
      inventory: transformedInventories,
      message: isRtl ? 'تم جلب مخزون الفرع بنجاح' : 'Branch inventory retrieved successfully',
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] getInventoryByBranch - Error:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      query: req.query,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  }
};

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] getInventory - Validation errors:`, errors.array());
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error',
      });
    }

    const { branch, product, department, lowStock, stockStatus } = req.query;
    const isRtl = req.query.lang === 'ar';

    // Build query
    const query = {};
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    }
    if (product && isValidObjectId(product)) {
      query.product = product;
    }
    if (department && isValidObjectId(department)) {
      query['product.department'] = department;
    }
    if (lowStock === 'true') {
      const inventories = await Inventory.find().lean();
      const filteredIds = inventories
        .filter((item) => item.currentStock <= item.minStockLevel)
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    } else if (stockStatus) {
      const inventories = await Inventory.find().lean();
      const filteredIds = inventories
        .filter((item) => {
          const isLow = item.currentStock <= item.minStockLevel;
          const isHigh = item.currentStock >= item.maxStockLevel;
          return stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
        })
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    }

    // Check user authorization for branch-specific queries
    if (req.user.role === 'branch' && branch && branch !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] getInventory - Unauthorized:`, {
        userId: req.user.id,
        branch,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لعرض مخزون هذا الفرع' : 'Not authorized to view inventory for this branch',
      });
    }

    // Fetch inventory
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    if (!inventories.length) {
      console.log(`[${new Date().toISOString()}] getInventory - No inventory found:`, { query });
      return res.status(200).json({
        success: true,
        inventory: [],
        message: isRtl ? 'لا توجد بيانات مخزون' : 'No inventory found',
      });
    }

    // Transform response
    const transformedInventories = inventories.map((item) => ({
      ...item,
      status:
        item.currentStock <= item.minStockLevel
          ? 'low'
          : item.currentStock >= item.maxStockLevel
          ? 'high'
          : 'normal',
      branch: {
        ...item.branch,
        displayName: translateField(item.branch, 'name', isRtl),
      },
      product: {
        ...item.product,
        displayName: translateField(item.product, 'name', isRtl),
        displayUnit: translateField(item.product, 'unit', isRtl),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: translateField(item.product.department, 'name', isRtl),
            }
          : null,
      },
      createdByDisplay: translateField(item.createdBy, 'name', isRtl),
      updatedByDisplay: translateField(item.updatedBy, 'name', isRtl),
    }));

    console.log(`[${new Date().toISOString()}] getInventory - Success:`, { itemCount: inventories.length });
    res.status(200).json({
      success: true,
      inventory: transformedInventories,
      message: isRtl ? 'تم جلب المخزون بنجاح' : 'Inventory retrieved successfully',
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] getInventory - Error:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  }
};

// Update inventory item
const updateInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] updateInventory - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error',
      });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, notes } = req.body;
    const isRtl = req.query.lang === 'ar';

    if (!isValidObjectId(id)) {
      console.log(`[${new Date().toISOString()}] updateInventory - Invalid inventory ID:`, { id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف المخزون غير صالح' : 'Invalid inventory ID',
      });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log(`[${new Date().toISOString()}] updateInventory - Inventory not found:`, { id });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'عنصر المخزون غير موجود' : 'Inventory item not found',
      });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] updateInventory - Unauthorized:`, {
        userId: req.user.id,
        branchId: inventory.branch,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Not authorized to update inventory for this branch',
      });
    }

    const previousStock = inventory.currentStock;
    const quantityChange = currentStock !== undefined ? currentStock - previousStock : 0;

    if (currentStock !== undefined && currentStock < 0) {
      console.log(`[${new Date().toISOString()}] updateInventory - Invalid quantity:`, { currentStock });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'الكمية يجب أن تكون غير سالبة' : 'Quantity must be non-negative',
      });
    }

    if (minStockLevel !== undefined && minStockLevel < 0) {
      console.log(`[${new Date().toISOString()}] updateInventory - Invalid min stock level:`, { minStockLevel });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'الحد الأدنى للمخزون يجب أن يكون غير سالب' : 'Min stock level must be non-negative',
      });
    }

    if (maxStockLevel !== undefined && maxStockLevel < (minStockLevel || inventory.minStockLevel)) {
      console.log(`[${new Date().toISOString()}] updateInventory - Invalid max stock level:`, {
        maxStockLevel,
        minStockLevel: minStockLevel || inventory.minStockLevel,
      });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'الحد الأقصى يجب أن يكون أكبر من أو يساوي الحد الأدنى' : 'Max stock level must be greater than or equal to min stock level',
      });
    }

    if (quantityChange !== 0) {
      const reference = isRtl
        ? `تعديل المخزون بواسطة ${req.user.username}`
        : `Inventory adjustment by ${req.user.username}`;

      await updateInventoryStock({
        branch: inventory.branch,
        product: inventory.product,
        quantity: quantityChange,
        type: 'adjustment',
        reference,
        referenceType: 'adjustment',
        referenceId: id,
        createdBy: req.user.id,
        session,
        isRtl,
        notes,
      });
    }

    if (minStockLevel !== undefined) inventory.minStockLevel = minStockLevel;
    if (maxStockLevel !== undefined) inventory.maxStockLevel = maxStockLevel;
    inventory.updatedBy = req.user.id;

    await inventory.save({ session });

    if (inventory.currentStock <= inventory.minStockLevel) {
      const product = await Product.findById(inventory.product).session(session);
      req.io?.emit('lowStockWarning', {
        branchId: inventory.branch,
        productId: inventory.product,
        productName: isRtl ? product.name : product.nameEn || product.name,
        currentStock: inventory.currentStock,
        minStockLevel: inventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch,
      productId: inventory.product,
      quantity: inventory.currentStock,
      type: 'adjustment',
      reference: isRtl
        ? `تعديل المخزون بواسطة ${req.user.username}`
        : `Inventory adjustment by ${req.user.username}`,
    });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    console.log(`[${new Date().toISOString()}] updateInventory - Success:`, {
      inventoryId: inventory._id,
      currentStock: inventory.currentStock,
      minStockLevel: inventory.minStockLevel,
      maxStockLevel: inventory.maxStockLevel,
    });

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      inventory: populatedItem,
      message: isRtl ? 'تم تحديث المخزون بنجاح' : 'Inventory updated successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] updateInventory - Error:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// Update stock levels
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] updateStock - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error',
      });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, branchId } = req.body;
    const isRtl = req.query.lang === 'ar';

    if (!isValidObjectId(id)) {
      console.log(`[${new Date().toISOString()}] updateStock - Invalid inventory ID:`, { id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف المخزون غير صالح' : 'Invalid inventory ID',
      });
    }

    // Validate inventory item
    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log(`[${new Date().toISOString()}] updateStock - Inventory not found:`, { id });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'عنصر المخزون غير موجود' : 'Inventory item not found',
      });
    }

    // Validate branch if provided
    if (branchId && !isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] updateStock - Invalid branch ID:`, { branchId });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID',
      });
    }

    const targetBranchId = branchId || inventory.branch.toString();
    if (req.user.role === 'branch' && targetBranchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] updateStock - Unauthorized:`, {
        userId: req.user.id,
        branchId: targetBranchId,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Not authorized to update inventory for this branch',
      });
    }

    // Validate updates
    const updates = {};
    if (currentStock !== undefined && !isNaN(currentStock) && currentStock >= 0) {
      if (req.user.role !== 'admin') {
        console.log(`[${new Date().toISOString()}] updateStock - Not authorized to update currentStock:`, { userId: req.user.id });
        await session.abortTransaction();
        return res.status(403).json({
          success: false,
          message: isRtl ? 'غير مخول لتحديث الكمية الحالية' : 'Not authorized to update current stock',
        });
      }
      updates.currentStock = currentStock;
    }
    if (minStockLevel !== undefined && !isNaN(minStockLevel) && minStockLevel >= 0) {
      updates.minStockLevel = minStockLevel;
    }
    if (maxStockLevel !== undefined && !isNaN(maxStockLevel) && maxStockLevel >= 0) {
      updates.maxStockLevel = maxStockLevel;
    }

    if (Object.keys(updates).length === 0) {
      console.log(`[${new Date().toISOString()}] updateStock - No updates provided:`, { id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'لا توجد بيانات للتحديث' : 'No updates provided',
      });
    }

    if (updates.minStockLevel !== undefined && updates.maxStockLevel !== undefined && updates.maxStockLevel <= updates.minStockLevel) {
      console.log(`[${new Date().toISOString()}] updateStock - Max stock less than or equal to min stock:`, {
        minStockLevel,
        maxStockLevel,
      });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' : 'Max stock level must be greater than min stock level',
      });
    }

    const reference = isRtl
      ? `تحديث المخزون بواسطة ${req.user.username}`
      : `Inventory update by ${req.user.username}`;
    updates.updatedBy = req.user.id;

    // Update inventory using updateInventoryStock if currentStock is changed
    let updatedInventory;
    if (currentStock !== undefined && currentStock !== inventory.currentStock) {
      updatedInventory = await updateInventoryStock({
        branch: inventory.branch,
        product: inventory.product,
        quantity: currentStock - inventory.currentStock,
        type: 'adjustment',
        reference,
        referenceType: 'adjustment',
        referenceId: id,
        createdBy: req.user.id,
        session,
        isRtl,
      });
    } else {
      // Update only min/max stock levels if no stock change
      updatedInventory = await Inventory.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, session }
      );
    }

    // Check for low stock
    if (updatedInventory.currentStock <= updatedInventory.minStockLevel) {
      const product = await Product.findById(updatedInventory.product).session(session);
      req.io?.emit('lowStockWarning', {
        branchId: updatedInventory.branch.toString(),
        productId: updatedInventory.product.toString(),
        productName: isRtl ? product.name : product.nameEn || product.name,
        currentStock: updatedInventory.currentStock,
        minStockLevel: updatedInventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }

    // Emit inventory update event
    req.io?.emit('inventoryUpdated', {
      branchId: updatedInventory.branch.toString(),
      productId: updatedInventory.product.toString(),
      quantity: updatedInventory.currentStock,
      minStockLevel: updatedInventory.minStockLevel,
      maxStockLevel: updatedInventory.maxStockLevel,
      type: 'adjustment',
      reference,
    });

    // Populate response
    const populatedItem = await Inventory.findById(updatedInventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    console.log(`[${new Date().toISOString()}] updateStock - Success:`, {
      inventoryId: id,
      updates,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      inventory: populatedItem,
      message: isRtl ? 'تم تحديث المخزون بنجاح' : 'Inventory updated successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] updateStock - Error:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] getInventoryHistory - Validation errors:`, errors.array());
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error',
      });
    }

    const { branchId, productId, department, period } = req.query;
    const isRtl = req.query.lang === 'ar';

    // Build query
    const query = {};
    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    }
    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }
    if (department && isValidObjectId(department)) {
      query['product.department'] = department;
    }
    if (period) {
      const now = new Date();
      let startDate;
      if (period === 'daily') {
        startDate = new Date(now.setHours(0, 0, 0, 0));
      } else if (period === 'weekly') {
        startDate = new Date(now.setDate(now.getDate() - now.getDay()));
        startDate.setHours(0, 0, 0, 0);
      } else if (period === 'monthly') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }
      query.createdAt = { $gte: startDate };
    }

    // Validate branch if provided
    if (branchId) {
      if (!isValidObjectId(branchId)) {
        console.log(`[${new Date().toISOString()}] getInventoryHistory - Invalid branch ID:`, { branchId });
        return res.status(400).json({
          success: false,
          message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID',
        });
      }
      if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
        console.log(`[${new Date().toISOString()}] getInventoryHistory - Unauthorized:`, {
          userId: req.user.id,
          branchId,
          userBranchId: req.user.branchId,
        });
        return res.status(403).json({
          success: false,
          message: isRtl ? 'غير مخول لعرض تاريخ مخزون هذا الفرع' : 'Not authorized to view inventory history for this branch',
        });
      }
    }

    // Fetch history
    const history = await InventoryHistory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean();

    if (!history.length) {
      console.log(`[${new Date().toISOString()}] getInventoryHistory - No history found:`, { query });
      return res.status(200).json({
        success: true,
        history: [],
        message: isRtl ? 'لا توجد بيانات تاريخ المخزون' : 'No inventory history found',
      });
    }

    // Transform response
    const transformedHistory = history.map((entry) => ({
      _id: entry._id,
      date: entry.createdAt,
      type: entry.action,
      quantity: entry.quantity,
      description: entry.reference,
      productId: entry.product?._id,
      branchId: entry.branch?._id,
      product: entry.product
        ? {
            ...entry.product,
            displayName: translateField(entry.product, 'name', isRtl),
          }
        : null,
      branch: entry.branch
        ? {
            ...entry.branch,
            displayName: translateField(entry.branch, 'name', isRtl),
          }
        : null,
      department: entry.product?.department
        ? {
            ...entry.product.department,
            displayName: translateField(entry.product.department, 'name', isRtl),
          }
        : null,
      createdByDisplay: entry.createdBy ? translateField(entry.createdBy, 'name', isRtl) : isRtl ? 'غير معروف' : 'Unknown',
    }));

    console.log(`[${new Date().toISOString()}] getInventoryHistory - Success:`, { itemCount: history.length });
    res.status(200).json({
      success: true,
      history: transformedHistory,
      message: isRtl ? 'تم جلب تاريخ المخزون بنجاح' : 'Inventory history retrieved successfully',
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] getInventoryHistory - Error:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  }
};

module.exports = {
  createInventory,
  bulkCreate,
  getInventoryByBranch,
  getInventory,
  updateInventory,
  updateStock,
  getInventoryHistory,
};