const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

// Create or update inventory item
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Create inventory - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array(), message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error' });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 10, maxStockLevel = 100, orderId } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      console.log(`[${new Date().toISOString()}] Create inventory - Invalid input:`, { branchId, productId, userId, currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' : 'Invalid branch, product, user ID, or quantity' });
    }

    // Check user authorization
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] Create inventory - User not found:`, { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'المستخدم غير موجود' : 'User not found' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Create inventory - Unauthorized:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: req.query.lang === 'ar' ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log(`[${new Date().toISOString()}] Create inventory - Product not found:`, { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'المنتج غير موجود' : 'Product not found' });
    }
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Create inventory - Branch not found:`, { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log(`[${new Date().toISOString()}] Create inventory - Invalid order ID:`, { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'معرف الطلبية غير صالح' : 'Invalid order ID' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log(`[${new Date().toISOString()}] Create inventory - Order not found:`, { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'الطلبية غير موجودة' : 'Order not found' });
      }
      if (order.status !== 'delivered') {
        console.log(`[${new Date().toISOString()}] Create inventory - Invalid order status:`, { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in delivered status' });
      }
    }

    const reference = orderId
      ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
      : `إنشاء مخزون بواسطة ${req.user.username}`;

    // Create or update inventory
    const inventory = await Inventory.findOneAndUpdate(
      { branch: branchId, product: productId },
      {
        $setOnInsert: {
          product: productId,
          branch: branchId,
          minStockLevel,
          maxStockLevel,
          createdBy: userId,
        },
        $inc: { currentStock },
        $push: {
          movements: {
            type: 'in',
            quantity: currentStock,
            reference,
            createdBy: userId,
            createdAt: new Date(),
          },
        },
        updatedBy: userId,
      },
      { upsert: true, new: true, session }
    );

    // Log to InventoryHistory
    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      action: 'restock',
      quantity: currentStock,
      reference,
      referenceType: orderId ? 'order' : 'adjustment',
      referenceId: orderId,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    // Check for low stock and emit notification
    if (inventory.currentStock <= inventory.minStockLevel) {
      const io = req.app.get('io');
      await createNotification(
        userId,
        'lowStockWarning',
        req.query.lang === 'ar' 
          ? `مخزون منخفض للمنتج ${product.name} في الفرع ${branch.name}`
          : `Low stock for product ${product.nameEn || product.name} in branch ${branch.nameEn || branch.name}`,
        { branchId, productId, currentStock: inventory.currentStock, minStockLevel: inventory.minStockLevel, eventId: `${inventory._id}-lowStock` },
        io,
        true
      );
    }

    // Populate response
    const populatedItem = await Inventory.findById(inventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    const formattedItem = {
      ...populatedItem,
      productName: translateField(populatedItem.product, 'name', req.query.lang || 'ar'),
      unit: translateField(populatedItem.product, 'unit', req.query.lang || 'ar'),
      departmentName: translateField(populatedItem.product.department, 'name', req.query.lang || 'ar'),
      branchName: translateField(populatedItem.branch, 'name', req.query.lang || 'ar'),
      createdByName: translateField(populatedItem.createdBy, 'name', req.query.lang || 'ar'),
      updatedByName: translateField(populatedItem.updatedBy, 'name', req.query.lang || 'ar'),
    };

    // Emit inventory update event
    const io = req.app.get('io');
    io.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
      timestamp: new Date().toISOString(),
    });

    console.log(`[${new Date().toISOString()}] Create inventory - Success:`, {
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
    res.status(201).json({ success: true, inventory: formattedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating inventory:`, { error: err.message, stack: err.stack, requestBody: req.body });
    let status = 500;
    let message = err.message || (req.query.lang === 'ar' ? 'خطأ في السيرفر' : 'Server error');
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير صالح') || message.includes('Invalid')) status = 400;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;

    res.status(status).json({ success: false, message, error: err.message });
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
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array(), message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error' });
    }

    const { branchId, userId, orderId, items } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid input:`, { branchId, userId, items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'معرف الفرع، المستخدم، أو العناصر غير صالحة' : 'Invalid branch, user ID, or items' });
    }

    // Validate user
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - User not found:`, { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'المستخدم غير موجود' : 'User not found' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Unauthorized:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: req.query.lang === 'ar' ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Branch not found:`, { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid order ID:`, { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'معرف الطلبية غير صالح' : 'Invalid order ID' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log(`[${new Date().toISOString()}] Bulk create inventory - Order not found:`, { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'الطلبية غير موجودة' : 'Order not found' });
      }
      if (order.status !== 'delivered') {
        console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid order status:`, { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in delivered status' });
      }
    }

    const productIds = items.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Some products not found:`, { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    const results = [];
    const historyEntries = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 10, maxStockLevel = 100 } = item;

      if (!isValidObjectId(productId) || currentStock < 0) {
        console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid item data:`, { productId, currentStock });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? `بيانات غير صالحة للمنتج ${productId}` : `Invalid data for product ${productId}` });
      }

      const product = products.find((p) => p._id.toString() === productId);
      if (!product) {
        console.log(`[${new Date().toISOString()}] Bulk create inventory - Product not found:`, { productId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? `المنتج ${productId} غير موجود` : `Product ${productId} not found` });
      }

      const reference = orderId
        ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
        : `إنشاء دفعة مخزون بواسطة ${req.user.username}`;

      const inventory = await Inventory.findOneAndUpdate(
        { branch: branchId, product: productId },
        {
          $setOnInsert: {
            product: productId,
            branch: branchId,
            minStockLevel,
            maxStockLevel,
            createdBy: userId,
          },
          $inc: { currentStock },
          $push: {
            movements: {
              type: 'in',
              quantity: currentStock,
              reference,
              createdBy: userId,
              createdAt: new Date(),
            },
          },
          updatedBy: userId,
        },
        { upsert: true, new: true, session }
      );

      historyEntries.push({
        product: productId,
        branch: branchId,
        action: 'restock',
        quantity: currentStock,
        reference,
        referenceType: orderId ? 'order' : 'adjustment',
        referenceId: orderId,
        createdBy: userId,
      });

      if (inventory.currentStock <= inventory.minStockLevel) {
        const io = req.app.get('io');
        await createNotification(
          userId,
          'lowStockWarning',
          req.query.lang === 'ar' 
            ? `مخزون منخفض للمنتج ${product.name} في الفرع ${branch.name}`
            : `Low stock for product ${product.nameEn || product.name} in branch ${branch.nameEn || branch.name}`,
          { branchId, productId, currentStock: inventory.currentStock, minStockLevel: inventory.minStockLevel, eventId: `${inventory._id}-lowStock` },
          io,
          true
        );
      }

      const io = req.app.get('io');
      io.emit('inventoryUpdated', {
        branchId,
        productId,
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
        timestamp: new Date().toISOString(),
      });

      results.push(inventory._id);
    }

    await InventoryHistory.insertMany(historyEntries, { session });

    const populatedItems = await Inventory.find({ _id: { $in: results } })
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    const formattedItems = populatedItems.map(item => ({
      ...item,
      productName: translateField(item.product, 'name', req.query.lang || 'ar'),
      unit: translateField(item.product, 'unit', req.query.lang || 'ar'),
      departmentName: translateField(item.product.department, 'name', req.query.lang || 'ar'),
      branchName: translateField(item.branch, 'name', req.query.lang || 'ar'),
      createdByName: translateField(item.createdBy, 'name', req.query.lang || 'ar'),
      updatedByName: translateField(item.updatedBy, 'name', req.query.lang || 'ar'),
    }));

    console.log(`[${new Date().toISOString()}] Bulk create inventory - Success:`, { branchId, userId, orderId, itemCount: items.length });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: formattedItems });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error bulk creating inventory:`, { error: err.message, stack: err.stack, requestBody: req.body });
    let status = 500;
    let message = err.message || (req.query.lang === 'ar' ? 'خطأ في السيرفر' : 'Server error');
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير صالح') || message.includes('Invalid')) status = 400;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;

    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory for a specific branch
const getInventoryByBranch = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Validation errors:`, errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error' });
    }

    const { branchId } = req.params;
    const { department, stockStatus, page = 1, limit = 10 } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Invalid branch ID:`, { branchId });
      return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Unauthorized:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: req.query.lang === 'ar' ? 'غير مخول لعرض مخزون هذا الفرع' : 'Not authorized to view inventory for this branch' });
    }

    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Branch not found:`, { branchId });
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
    }

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

    const total = await Inventory.countDocuments(query);
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    if (!inventories.length) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - No inventory data:`, { branchId, department, stockStatus });
      return res.status(200).json({ success: true, inventory: [], total });
    }

    const formattedInventories = inventories.map(item => ({
      ...item,
      productName: translateField(item.product, 'name', req.query.lang || 'ar'),
      unit: translateField(item.product, 'unit', req.query.lang || 'ar'),
      departmentName: translateField(item.product.department, 'name', req.query.lang || 'ar'),
      branchName: translateField(item.branch, 'name', req.query.lang || 'ar'),
      createdByName: translateField(item.createdBy, 'name', req.query.lang || 'ar'),
      updatedByName: translateField(item.updatedBy, 'name', req.query.lang || 'ar'),
    }));

    console.log(`[${new Date().toISOString()}] Get inventory by branch - Success:`, { branchId, department, stockStatus, itemCount: inventories.length });

    res.status(200).json({ success: true, inventory: formattedInventories, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error getting inventory by branch:`, { error: err.message, stack: err.stack, params: req.params, query: req.query });
    let status = 500;
    let message = err.message || (req.query.lang === 'ar' ? 'خطأ في السيرفر' : 'Server error');
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير صالح') || message.includes('Invalid')) status = 400;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;

    res.status(status).json({ success: false, message, error: err.message });
  }
};

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Get inventory - Validation errors:`, errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error' });
    }

    const { branch, product, department, lowStock, stockStatus, page = 1, limit = 10 } = req.query;

    const query = {};
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (product && isValidObjectId(product)) query.product = product;
    if (department && isValidObjectId(department)) query['product.department'] = department;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    if (lowStock === 'true' || stockStatus) {
      const inventories = await Inventory.find(query).lean();
      const filteredIds = inventories
        .filter((item) => {
          const isLow = item.currentStock <= item.minStockLevel;
          const isHigh = item.currentStock >= item.maxStockLevel;
          if (lowStock === 'true') return isLow;
          return stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
        })
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    }

    const total = await Inventory.countDocuments(query);
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    if (!inventories.length) {
      console.log(`[${new Date().toISOString()}] Get inventory - No inventory data:`, { branch, product, department, lowStock, stockStatus });
      return res.status(200).json({ success: true, inventory: [], total });
    }

    const formattedInventories = inventories.map(item => ({
      ...item,
      productName: translateField(item.product, 'name', req.query.lang || 'ar'),
      unit: translateField(item.product, 'unit', req.query.lang || 'ar'),
      departmentName: translateField(item.product.department, 'name', req.query.lang || 'ar'),
      branchName: translateField(item.branch, 'name', req.query.lang || 'ar'),
      createdByName: translateField(item.createdBy, 'name', req.query.lang || 'ar'),
      updatedByName: translateField(item.updatedBy, 'name', req.query.lang || 'ar'),
    }));

    console.log(`[${new Date().toISOString()}] Get inventory - Success:`, { branch, product, department, lowStock, stockStatus, itemCount: inventories.length });

    res.status(200).json({ success: true, inventory: formattedInventories, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error getting inventory:`, { error: err.message, stack: err.stack, query: req.query });
    let status = 500;
    let message = err.message || (req.query.lang === 'ar' ? 'خطأ في السيرفر' : 'Server error');
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير صالح') || message.includes('Invalid')) status = 400;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;

    res.status(status).json({ success: false, message, error: err.message });
  }
};

// Update inventory stock
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Update stock - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array(), message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error' });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, branchId } = req.body;

    if (!isValidObjectId(id)) {
      console.log(`[${new Date().toISOString()}] Update stock - Invalid inventory ID:`, { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'معرف المخزون غير صالح' : 'Invalid inventory ID' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log(`[${new Date().toISOString()}] Update stock - Inventory not found:`, { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'المخزون غير موجود' : 'Inventory not found' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Update stock - Unauthorized:`, { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: req.query.lang === 'ar' ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Not authorized to update inventory for this branch' });
    }

    if (branchId && isValidObjectId(branchId)) {
      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        console.log(`[${new Date().toISOString()}] Update stock - Branch not found:`, { branchId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: req.query.lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
      }
      inventory.branch = branchId;
    }

    const updates = {};
    let quantityChange = 0;
    if (currentStock !== undefined) {
      if (currentStock < 0) {
        console.log(`[${new Date().toISOString()}] Update stock - Negative stock:`, { id, currentStock });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'الكمية الحالية لا يمكن أن تكون سالبة' : 'Current stock cannot be negative' });
      }
      quantityChange = currentStock - inventory.currentStock;
      updates.currentStock = currentStock;
    }
    if (minStockLevel !== undefined) {
      if (minStockLevel < 0) {
        console.log(`[${new Date().toISOString()}] Update stock - Negative min stock level:`, { id, minStockLevel });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'الحد الأدنى للمخزون لا يمكن أن يكون سالبًا' : 'Min stock level cannot be negative' });
      }
      updates.minStockLevel = minStockLevel;
    }
    if (maxStockLevel !== undefined) {
      if (maxStockLevel < (updates.minStockLevel || inventory.minStockLevel)) {
        console.log(`[${new Date().toISOString()}] Update stock - Invalid max stock level:`, { id, maxStockLevel, minStockLevel: updates.minStockLevel || inventory.minStockLevel });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'الحد الأقصى يجب أن يكون أكبر من أو يساوي الحد الأدنى' : 'Max stock level must be greater than or equal to min stock level' });
      }
      updates.maxStockLevel = maxStockLevel;
    }

    if (Object.keys(updates).length === 0) {
      console.log(`[${new Date().toISOString()}] Update stock - No updates provided:`, { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: req.query.lang === 'ar' ? 'لم يتم تقديم أي تحديثات' : 'No updates provided' });
    }

    updates.updatedBy = req.user.id;

    if (quantityChange !== 0) {
      updates.movements = {
        $push: {
          type: quantityChange > 0 ? 'in' : 'out',
          quantity: Math.abs(quantityChange),
          reference: `تعديل المخزون بواسطة ${req.user.username}`,
          createdBy: req.user.id,
          createdAt: new Date(),
        },
      };

      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        action: 'adjustment',
        quantity: quantityChange,
        reference: `تعديل المخزون بواسطة ${req.user.username}`,
        referenceType: 'adjustment',
        referenceId: inventory._id,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    const updatedInventory = await Inventory.findByIdAndUpdate(id, updates, { new: true, session })
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    if (updatedInventory.currentStock <= updatedInventory.minStockLevel) {
      const io = req.app.get('io');
      const product = await Product.findById(updatedInventory.product._id).session(session);
      const branch = await Branch.findById(updatedInventory.branch._id).session(session);
      await createNotification(
        req.user.id,
        'lowStockWarning',
        req.query.lang === 'ar' 
          ? `مخزون منخفض للمنتج ${product.name} في الفرع ${branch.name}`
          : `Low stock for product ${product.nameEn || product.name} in branch ${branch.nameEn || branch.name}`,
        { branchId: updatedInventory.branch._id, productId: updatedInventory.product._id, currentStock: updatedInventory.currentStock, minStockLevel: updatedInventory.minStockLevel, eventId: `${updatedInventory._id}-lowStock` },
        io,
        true
      );
    }

    const io = req.app.get('io');
    io.emit('inventoryUpdated', {
      branchId: updatedInventory.branch._id,
      productId: updatedInventory.product._id,
      quantity: updatedInventory.currentStock,
      type: 'adjustment',
      reference: `تعديل المخزون بواسطة ${req.user.username}`,
      timestamp: new Date().toISOString(),
    });

    console.log(`[${new Date().toISOString()}] Update stock - Success:`, { inventoryId: id, updates });

    await session.commitTransaction();
    const formattedInventory = {
      ...updatedInventory,
      productName: translateField(updatedInventory.product, 'name', req.query.lang || 'ar'),
      unit: translateField(updatedInventory.product, 'unit', req.query.lang || 'ar'),
      departmentName: translateField(updatedInventory.product.department, 'name', req.query.lang || 'ar'),
      branchName: translateField(updatedInventory.branch, 'name', req.query.lang || 'ar'),
      createdByName: translateField(updatedInventory.createdBy, 'name', req.query.lang || 'ar'),
      updatedByName: translateField(updatedInventory.updatedBy, 'name', req.query.lang || 'ar'),
    };

    res.status(200).json({ success: true, inventory: formattedInventory });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating stock:`, { error: err.message, stack: err.stack, params: req.params, requestBody: req.body });
    let status = 500;
    let message = err.message || (req.query.lang === 'ar' ? 'خطأ في السيرفر' : 'Server error');
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('negative') || message.includes('provided')) status = 400;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;

    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Get inventory history - Validation errors:`, errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error' });
    }

    const { branchId, productId, department, period, page = 1, limit = 10 } = req.query;

    const query = {};
    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
      if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
        console.log(`[${new Date().toISOString()}] Get inventory history - Unauthorized:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
        return res.status(403).json({ success: false, message: req.query.lang === 'ar' ? 'غير مخول لعرض تاريخ مخزون هذا الفرع' : 'Not authorized to view inventory history for this branch' });
      }
    } else if (req.user.role === 'branch') {
      query.branch = req.user.branchId;
    }
    if (productId && isValidObjectId(productId)) query.product = productId;
    if (department && isValidObjectId(department)) {
      const products = await Product.find({ department }).select('_id').lean();
      query.product = { $in: products.map(p => p._id) };
    }

    if (period) {
      const now = new Date();
      let startDate;
      if (period === 'daily') startDate = new Date(now.setHours(0, 0, 0, 0));
      else if (period === 'weekly') startDate = new Date(now.setDate(now.getDate() - now.getDay()));
      else if (period === 'monthly') startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      query.createdAt = { $gte: startDate };
    }

    const total = await InventoryHistory.countDocuments(query);
    const history = await InventoryHistory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    if (!history.length) {
      console.log(`[${new Date().toISOString()}] Get inventory history - No history data:`, { branchId, productId, department, period });
      return res.status(200).json({ success: true, history: [], total });
    }

    const formattedHistory = history.map(item => ({
      ...item,
      productName: translateField(item.product, 'name', req.query.lang || 'ar'),
      unit: translateField(item.product, 'unit', req.query.lang || 'ar'),
      departmentName: translateField(item.product.department, 'name', req.query.lang || 'ar'),
      branchName: translateField(item.branch, 'name', req.query.lang || 'ar'),
      createdByName: translateField(item.createdBy, 'name', req.query.lang || 'ar'),
      action: req.query.lang === 'ar' ? translateAction(item.action, 'ar') : item.action,
    }));

    console.log(`[${new Date().toISOString()}] Get inventory history - Success:`, { branchId, productId, department, period, itemCount: history.length });

    res.status(200).json({ success: true, history: formattedHistory, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error getting inventory history:`, { error: err.message, stack: err.stack, query: req.query });
    let status = 500;
    let message = err.message || (req.query.lang === 'ar' ? 'خطأ في السيرفر' : 'Server error');
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير صالح') || message.includes('Invalid')) status = 400;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;

    res.status(status).json({ success: false, message, error: err.message });
  }
};

// Helper function to translate action types
const translateAction = (action, lang) => {
  const actionMap = {
    delivery: lang === 'ar' ? 'تسليم' : 'Delivery',
    return_pending: lang === 'ar' ? 'إرجاع معلق' : 'Return Pending',
    return_rejected: lang === 'ar' ? 'إرجاع مرفوض' : 'Return Rejected',
    return_approved: lang === 'ar' ? 'إرجاع موافق عليه' : 'Return Approved',
    sale: lang === 'ar' ? 'بيع' : 'Sale',
    sale_cancelled: lang === 'ar' ? 'بيع ملغى' : 'Sale Cancelled',
    sale_deleted: lang === 'ar' ? 'بيع محذوف' : 'Sale Deleted',
    restock: lang === 'ar' ? 'إعادة تخزين' : 'Restock',
    adjustment: lang === 'ar' ? 'تعديل' : 'Adjustment',
    settings_adjustment: lang === 'ar' ? 'تعديل إعدادات' : 'Settings Adjustment',
  };
  return actionMap[action] || action;
};

module.exports = {
  createInventory,
  bulkCreate,
  getInventoryByBranch,
  getInventory,
  updateStock,
  getInventoryHistory,
};