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
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء عنصر مخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 10, maxStockLevel = 100, orderId } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      console.log('إنشاء عنصر مخزون - بيانات غير صالحة:', { branchId, productId, userId, currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' });
    }

    // Check user authorization
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('إنشاء عنصر مخزون - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود', error: 'errors.no_user' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء عنصر مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log('إنشاء عنصر مخزون - المنتج غير موجود:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log('إنشاء عنصر مخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log('إنشاء عنصر مخزون - معرف الطلب غير صالح:', { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log('إنشاء عنصر مخزون - الطلب غير موجود:', { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        console.log('إنشاء عنصر مخزون - حالة الطلب غير صالحة:', { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'يجب أن تكون الطلبية في حالة "تم التسليم"' });
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
        productName: translateField(product, 'name', req.query.lang || 'ar'),
        currentStock: inventory.currentStock,
        minStockLevel: inventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }

    // Populate response
    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
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

    console.log('إنشاء/تحديث عنصر مخزون - تم بنجاح:', {
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
    console.error('خطأ في إنشاء/تحديث المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
      console.log('إنشاء دفعة مخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branchId, userId, orderId, items } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      console.log('إنشاء دفعة مخزون - بيانات غير صالحة:', { branchId, userId, items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، المستخدم، أو العناصر غير صالحة' });
    }

    // Validate user
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('إنشاء دفعة مخزون - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود', error: 'errors.no_user' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء دفعة مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('إنشاء دفعة مخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log('إنشاء دفعة مخزون - معرف الطلب غير صالح:', { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log('إنشاء دفعة مخزون - الطلب غير موجود:', { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        console.log('إنشاء دفعة مخزون - حالة الطلب غير صالحة:', { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'يجب أن تكون الطلبية في حالة "تم التسليم"' });
      }
    }

    // Validate products
    const productIds = items.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      console.log('إنشاء دفعة مخزون - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'بعض المنتجات غير موجودة' });
    }

    const results = [];
    const historyEntries = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 10, maxStockLevel = 100 } = item;

      if (!isValidObjectId(productId) || currentStock < 0) {
        console.log('إنشاء دفعة مخزون - بيانات عنصر غير صالحة:', { productId, currentStock });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `بيانات غير صالحة للمنتج ${productId}` });
      }

      const product = products.find((p) => p._id.toString() === productId);
      if (!product) {
        console.log('إنشاء دفعة مخزون - المنتج غير موجود:', { productId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: `المنتج ${productId} غير موجود` });
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
          productName: translateField(product, 'name', req.query.lang || 'ar'),
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
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    console.log('إنشاء دفعة مخزون - تم بنجاح:', { branchId, userId, orderId, itemCount: items.length });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: populatedItems });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء دفعة المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory for a specific branch
const getInventoryByBranch = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب مخزون الفرع - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branchId } = req.params;
    const { department, stockStatus } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log('جلب مخزون الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    // Check user authorization
    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب مخزون الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لعرض مخزون هذا الفرع' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
      console.log('جلب مخزون الفرع - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
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
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    if (!inventories.length) {
      console.log('جلب مخزون الفرع - لا توجد بيانات مخزون:', { branchId, department, stockStatus });
      return res.status(200).json({ success: true, inventory: [] });
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
    }));

    console.log('جلب مخزون الفرع - تم بنجاح:', { branchId, itemCount: inventories.length });

    res.status(200).json({ success: true, inventory: transformedInventories });
  } catch (err) {
    console.error('خطأ في جلب مخزون الفرع:', { error: err.message, stack: err.stack, params: req.params, query: req.query });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب كل المخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branch, product, department, lowStock, stockStatus } = req.query;

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

    // Fetch inventory
    const inventories = await Inventory.find(query)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    if (!inventories.length) {
      console.log('جلب كل المخزون - لا توجد بيانات مخزون:', { query });
      return res.status(200).json({ success: true, inventory: [] });
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
    }));

    console.log('جلب كل المخزون - تم بنجاح:', { itemCount: inventories.length });

    res.status(200).json({ success: true, inventory: transformedInventories });
  } catch (err) {
    console.error('خطأ في جلب كل المخزون:', { error: err.message, stack: err.stack, query: req.query });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update stock levels
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث المخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, branchId } = req.body;

    if (!isValidObjectId(id)) {
      console.log('تحديث المخزون - معرف المخزون غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    // Validate inventory item
    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث المخزون - المخزون غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
    }

    // Validate branch
    if (branchId && !isValidObjectId(branchId)) {
      console.log('تحديث المخزون - معرف الفرع غير صالح:', { branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    const targetBranchId = branchId || inventory.branch.toString();
    if (req.user.role === 'branch' && targetBranchId !== req.user.branchId?.toString()) {
      console.log('تحديث المخزون - غير مخول:', { userId: req.user.id, branchId: targetBranchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    // Validate updates
    const updates = {};
    if (currentStock !== undefined && !isNaN(currentStock) && currentStock >= 0) {
      if (req.user.role !== 'admin') {
        console.log('تحديث المخزون - غير مخول لتحديث الكمية الحالية:', { userId: req.user.id });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: 'غير مخول لتحديث الكمية الحالية' });
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
      console.log('تحديث المخزون - لا توجد بيانات للتحديث:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'لا توجد بيانات للتحديث' });
    }

    if (updates.minStockLevel !== undefined && updates.maxStockLevel !== undefined && updates.maxStockLevel <= updates.minStockLevel) {
      console.log('تحديث المخزون - الحد الأقصى أقل من أو يساوي الحد الأدنى:', { minStockLevel, maxStockLevel });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' });
    }

    const reference = `تحديث المخزون بواسطة ${req.user.username}`;
    updates.updatedBy = req.user.id;

    // Update inventory
    const updatedInventory = await Inventory.findByIdAndUpdate(
      id,
      {
        $set: updates,
        $push: {
          movements: {
            type: 'adjustment',
            quantity: currentStock !== undefined ? currentStock - inventory.currentStock : 0,
            reference,
            createdBy: req.user.id,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );

    // Log to InventoryHistory if stock changed
    if (currentStock !== undefined && currentStock !== inventory.currentStock) {
      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        action: 'adjustment',
        quantity: currentStock - inventory.currentStock,
        reference,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    // Check for low stock
    if (updatedInventory.currentStock <= updatedInventory.minStockLevel) {
      const product = await Product.findById(updatedInventory.product).session(session);
      req.io?.emit('lowStockWarning', {
        branchId: updatedInventory.branch.toString(),
        productId: updatedInventory.product.toString(),
        productName: translateField(product, 'name', req.query.lang || 'ar'),
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
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: id,
      updates,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack, params: req.params, body: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب تاريخ المخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branchId, productId, department, period } = req.query;

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
        console.log('جلب تاريخ المخزون - معرف الفرع غير صالح:', { branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
        console.log('جلب تاريخ المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
        return res.status(403).json({ success: false, message: 'غير مخول لعرض تاريخ مخزون هذا الفرع' });
      }
    }

    // Fetch history
    const history = await InventoryHistory.find(query)
      .populate('product', 'name nameEn')
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean();

    if (!history.length) {
      console.log('جلب تاريخ المخزون - لا توجد بيانات تاريخ:', { query });
      return res.status(200).json({ success: true, history: [] });
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
    }));

    console.log('جلب تاريخ المخزون - تم بنجاح:', { itemCount: history.length });

    res.status(200).json({ success: true, history: transformedHistory });
  } catch (err) {
    console.error('خطأ في جلب تاريخ المخزون:', { error: err.message, stack: err.stack, query: req.query });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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