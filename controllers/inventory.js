const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper function to handle translations based on language
const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

// Create or update inventory item
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - أخطاء التحقق:`, errors.array());
      throw new Error(isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error');
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 10, maxStockLevel = 100, orderId } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - بيانات غير صالحة:`, { branchId, productId, userId, currentStock });
      throw new Error(isRtl ? 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' : 'Invalid branch, product, user ID, or quantity');
    }

    // Check user authorization
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - المستخدم غير موجود:`, { userId });
      throw new Error(isRtl ? 'المستخدم غير موجود' : 'User not found');
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - غير مخول:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      throw new Error(isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch');
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - المنتج غير موجود:`, { productId });
      throw new Error(isRtl ? 'المنتج غير موجود' : 'Product not found');
    }
    if (!branch) {
      console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - الفرع غير موجود:`, { branchId });
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - معرف الطلب غير صالح:`, { orderId });
        throw new Error(isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID');
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - الطلب غير موجود:`, { orderId });
        throw new Error(isRtl ? 'الطلب غير موجود' : 'Order not found');
      }
      if (order.status !== 'delivered') {
        console.log(`[${new Date().toISOString()}] إنشاء عنصر مخزون - حالة الطلب غير صالحة:`, { orderId, status: order.status });
        throw new Error(isRtl ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in "delivered" status');
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
      createdBy: userId,
    });
    await historyEntry.save({ session });

    // Check for low stock and emit notification
    if (inventory.currentStock <= inventory.minStockLevel) {
      req.io?.emit('lowStockWarning', {
        branchId,
        productId,
        productName: translateField(product, 'name', lang),
        currentStock: inventory.currentStock,
        minStockLevel: inventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }

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

    // Emit inventory update event
    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
    });

    console.log(`[${new Date().toISOString()}] إنشاء/تحديث عنصر مخزون - تم بنجاح:`, {
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
    res.status(201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء/تحديث المخزون:`, {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

// Bulk create or update inventory items
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - أخطاء التحقق:`, errors.array());
      throw new Error(isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error');
    }

    const { branchId, userId, orderId, items } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - بيانات غير صالحة:`, { branchId, userId, items });
      throw new Error(isRtl ? 'معرف الفرع، المستخدم، أو العناصر غير صالحة' : 'Invalid branch, user ID, or items');
    }

    // Validate user
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - المستخدم غير موجود:`, { userId });
      throw new Error(isRtl ? 'المستخدم غير موجود' : 'User not found');
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - غير مخول:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      throw new Error(isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch');
    }

    // Validate branch
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - الفرع غير موجود:`, { branchId });
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - معرف الطلب غير صالح:`, { orderId });
        throw new Error(isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID');
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - الطلب غير موجود:`, { orderId });
        throw new Error(isRtl ? 'الطلب غير موجود' : 'Order not found');
      }
      if (order.status !== 'delivered') {
        console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - حالة الطلب غير صالحة:`, { orderId, status: order.status });
        throw new Error(isRtl ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in "delivered" status');
      }
    }

    // Validate products
    const productIds = items.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - بعض المنتجات غير موجودة:`, { productIds });
      throw new Error(isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found');
    }

    const results = [];
    const historyEntries = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 10, maxStockLevel = 100 } = item;

      if (!isValidObjectId(productId) || currentStock < 0) {
        console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - بيانات عنصر غير صالحة:`, { productId, currentStock });
        throw new Error(isRtl ? `بيانات غير صالحة للمنتج ${productId}` : `Invalid data for product ${productId}`);
      }

      const product = products.find((p) => p._id.toString() === productId);
      if (!product) {
        console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - المنتج غير موجود:`, { productId });
        throw new Error(isRtl ? `المنتج ${productId} غير موجود` : `Product ${productId} not found`);
      }

      const reference = orderId
        ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
        : `إنشاء دفعة مخزون بواسطة ${req.user.username}`;

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
      historyEntries.push({
        product: productId,
        branch: branchId,
        action: 'restock',
        quantity: currentStock,
        reference,
        createdBy: userId,
      });

      // Check for low stock
      if (inventory.currentStock <= inventory.minStockLevel) {
        req.io?.emit('lowStockWarning', {
          branchId,
          productId,
          productName: translateField(product, 'name', lang),
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

    // Save history entries
    await InventoryHistory.insertMany(historyEntries, { session });

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

    console.log(`[${new Date().toISOString()}] إنشاء دفعة مخزون - تم بنجاح:`, {
      branchId,
      userId,
      orderId,
      itemCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: populatedItems });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء دفعة المخزون:`, {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory for a specific branch
const getInventoryByBranch = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] جلب مخزون الفرع - أخطاء التحقق:`, errors.array());
      throw new Error(isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error');
    }

    const { branchId } = req.params;
    const { department, stockStatus, page = 1, limit = 10 } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] جلب مخزون الفرع - معرف الفرع غير صالح:`, { branchId });
      throw new Error(isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID');
    }

    // Check user authorization
    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] جلب مخزون الفرع - غير مخول:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      throw new Error(isRtl ? 'غير مخول لعرض مخزون هذا الفرع' : 'Not authorized to view inventory for this branch');
    }

    // Validate branch
    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
      console.log(`[${new Date().toISOString()}] جلب مخزون الفرع - الفرع غير موجود:`, { branchId });
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    // Build query
    const query = { branch: branchId, product: { $ne: null } };
    if (department && isValidObjectId(department)) {
      query['product.department'] = department;
    }
    if (stockStatus) {
      const inventories = await Inventory.find({ branch: branchId, product: { $ne: null } }).lean();
      const filteredIds = inventories
        .filter((item) => {
          const isLow = item.currentStock <= item.minStockLevel;
          const isHigh = item.currentStock >= item.maxStockLevel;
          return stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
        })
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    }

    // Fetch inventory with pagination
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Inventory.countDocuments(query);

    if (!inventories.length) {
      console.log(`[${new Date().toISOString()}] جلب مخزون الفرع - لا توجد بيانات مخزون:`, { branchId, department, stockStatus });
      return res.status(200).json({ success: true, inventory: [], total });
    }

    // Transform response
    const transformedInventories = inventories.map((item) => ({
      ...item,
      status:
        item.currentStock <= item.minStockLevel
          ? 'low'
          : item.currentStock >= item.maxStockLevel
          ? 'full'
          : 'normal',
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn || item.branch?.name || 'Unknown',
      productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name || 'Unknown',
      unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
      departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name || 'Unknown',
    }));

    console.log(`[${new Date().toISOString()}] جلب مخزون الفرع - تم بنجاح:`, { branchId, itemCount: inventories.length, total });

    res.status(200).json({ success: true, inventory: transformedInventories, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب مخزون الفرع:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      query: req.query,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

// Get all inventory items
const getInventory = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] جلب كل المخزون - أخطاء التحقق:`, errors.array());
      throw new Error(isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error');
    }

    const { branch, product, department, lowStock, stockStatus, page = 1, limit = 10 } = req.query;

    // Build query
    const query = { product: { $ne: null } };
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    }
    if (product && isValidObjectId(product)) {
      query.product = product;
    }
    if (department && isValidObjectId(department)) {
      query['product.department'] = department;
    }
    if (lowStock === 'true' || stockStatus) {
      const inventories = await Inventory.find({ product: { $ne: null } }).lean();
      const filteredIds = inventories
        .filter((item) => {
          const isLow = item.currentStock <= item.minStockLevel;
          const isHigh = item.currentStock >= item.maxStockLevel;
          return lowStock === 'true' || stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
        })
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    }

    // Fetch inventory with pagination
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Inventory.countDocuments(query);

    if (!inventories.length) {
      console.log(`[${new Date().toISOString()}] جلب كل المخزون - لا توجد بيانات مخزون:`, { query });
      return res.status(200).json({ success: true, inventory: [], total });
    }

    // Transform response
    const transformedInventories = inventories.map((item) => ({
      ...item,
      status:
        item.currentStock <= item.minStockLevel
          ? 'low'
          : item.currentStock >= item.maxStockLevel
          ? 'full'
          : 'normal',
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn || item.branch?.name || 'Unknown',
      productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name || 'Unknown',
      unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
      departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name || 'Unknown',
    }));

    console.log(`[${new Date().toISOString()}] جلب كل المخزون - تم بنجاح:`, { itemCount: inventories.length, total });

    res.status(200).json({ success: true, inventory: transformedInventories, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب كل المخزون:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

// Update stock levels
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - أخطاء التحقق:`, errors.array());
      throw new Error(isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error');
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, branchId } = req.body;

    if (!isValidObjectId(id)) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - معرف المخزون غير صالح:`, { id });
      throw new Error(isRtl ? 'معرف المخزون غير صالح' : 'Invalid inventory ID');
    }

    // Validate inventory item
    const inventory = await Inventory.findById(id).session(session);
    if (!inventory || !inventory.product) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - المخزون أو المنتج غير موجود:`, { id });
      throw new Error(isRtl ? 'عنصر المخزون أو المنتج غير موجود' : 'Inventory item or product not found');
    }

    // Validate branch
    if (branchId && !isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - معرف الفرع غير صالح:`, { branchId });
      throw new Error(isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID');
    }

    const targetBranchId = branchId || inventory.branch.toString();
    if (req.user.role === 'branch' && targetBranchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - غير مخول:`, { userId: req.user.id, branchId: targetBranchId, userBranchId: req.user.branchId });
      throw new Error(isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Not authorized to update inventory for this branch');
    }

    // Validate branch existence
    const branch = await Branch.findById(targetBranchId).session(session);
    if (!branch) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - الفرع غير موجود:`, { branchId: targetBranchId });
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    // Validate updates
    const updates = {};
    let quantityChange = 0;
    if (currentStock !== undefined && !isNaN(currentStock) && currentStock >= 0) {
      if (req.user.role !== 'admin') {
        console.log(`[${new Date().toISOString()}] تحديث المخزون - غير مخول لتحديث الكمية الحالية:`, { userId: req.user.id });
        throw new Error(isRtl ? 'غير مخول لتحديث الكمية الحالية' : 'Not authorized to update current stock');
      }
      quantityChange = currentStock - inventory.currentStock;
      updates.currentStock = currentStock;
    }
    if (minStockLevel !== undefined && !isNaN(minStockLevel) && minStockLevel >= 0) {
      updates.minStockLevel = minStockLevel;
    }
    if (maxStockLevel !== undefined && !isNaN(maxStockLevel) && maxStockLevel >= 0) {
      updates.maxStockLevel = maxStockLevel;
    }
    if (branchId && branchId !== inventory.branch.toString()) {
      updates.branch = branchId;
    }

    if (Object.keys(updates).length === 0) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - لا توجد بيانات للتحديث:`, { id });
      throw new Error(isRtl ? 'لا توجد بيانات للتحديث' : 'No data to update');
    }

    if (updates.minStockLevel !== undefined && updates.maxStockLevel !== undefined && updates.maxStockLevel <= updates.minStockLevel) {
      console.log(`[${new Date().toISOString()}] تحديث المخزون - الحد الأقصى أقل من أو يساوي الحد الأدنى:`, { minStockLevel, maxStockLevel });
      throw new Error(isRtl ? 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' : 'Max stock level must be greater than min stock level');
    }

    const reference = `تعديل المخزون بواسطة ${req.user.username}`;
    updates.updatedBy = req.user.id;

    // Update inventory
    const updatedInventory = await Inventory.findByIdAndUpdate(
      id,
      {
        $set: updates,
        $push: quantityChange !== 0 ? {
          movements: {
            type: quantityChange > 0 ? 'in' : 'out',
            quantity: Math.abs(quantityChange),
            reference,
            createdBy: req.user.id,
            createdAt: new Date(),
          },
        } : undefined,
      },
      { new: true, session }
    );

    // Log to InventoryHistory if stock changed
    if (quantityChange !== 0) {
      const historyEntry = new InventoryHistory({
        product: updatedInventory.product,
        branch: targetBranchId,
        action: 'adjustment',
        quantity: quantityChange,
        reference,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    // Check for low stock
    if (updatedInventory.currentStock <= updatedInventory.minStockLevel) {
      const product = await Product.findById(updatedInventory.product).session(session);
      req.io?.emit('lowStockWarning', {
        branchId: targetBranchId,
        productId: updatedInventory.product.toString(),
        productName: translateField(product, 'name', lang),
        currentStock: updatedInventory.currentStock,
        minStockLevel: updatedInventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }

    // Emit inventory update event
    if (quantityChange !== 0) {
      req.io?.emit('inventoryUpdated', {
        branchId: targetBranchId,
        productId: updatedInventory.product.toString(),
        quantity: updatedInventory.currentStock,
        type: 'adjustment',
        reference,
      });
    }

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

    console.log(`[${new Date().toISOString()}] تحديث المخزون - تم بنجاح:`, {
      inventoryId: updatedInventory._id,
      productId: updatedInventory.product.toString(),
      branchId: targetBranchId,
      currentStock: updatedInventory.currentStock,
      minStockLevel: updatedInventory.minStockLevel,
      maxStockLevel: updatedInventory.maxStockLevel,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تحديث المخزون:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    else if (err.message.includes('لا توجد بيانات') || err.message.includes('No data')) status = 400;
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] جلب تاريخ المخزون - أخطاء التحقق:`, errors.array());
      throw new Error(isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error');
    }

    const { branchId, productId, department, period, page = 1, limit = 10 } = req.query;

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
        console.log(`[${new Date().toISOString()}] جلب تاريخ المخزون - معرف الفرع غير صالح:`, { branchId });
        throw new Error(isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID');
      }
      if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
        console.log(`[${new Date().toISOString()}] جلب تاريخ المخزون - غير مخول:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
        throw new Error(isRtl ? 'غير مخول لعرض تاريخ مخزون هذا الفرع' : 'Not authorized to view inventory history for this branch');
      }
    }

    // Fetch history with pagination
    const history = await InventoryHistory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await InventoryHistory.countDocuments(query);

    if (!history.length) {
      console.log(`[${new Date().toISOString()}] جلب تاريخ المخزون - لا توجد بيانات تاريخ:`, { query });
      return res.status(200).json({ success: true, history: [], total });
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
      productName: isRtl ? entry.product?.name : entry.product?.nameEn || entry.product?.name || 'Unknown',
      branchName: isRtl ? entry.branch?.name : entry.branch?.nameEn || entry.branch?.name || 'Unknown',
      departmentName: isRtl ? entry.product?.department?.name : entry.product?.department?.nameEn || entry.product?.department?.name || 'Unknown',
    }));

    console.log(`[${new Date().toISOString()}] جلب تاريخ المخزون - تم بنجاح:`, { itemCount: history.length, total });

    res.status(200).json({ success: true, history: transformedHistory, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب تاريخ المخزون:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

module.exports = {
  createInventory,
  bulkCreate,
  getInventoryByBranch,
  getInventory,
  updateStock,
  getInventoryHistory,
};