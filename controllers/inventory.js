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
      query.currentStock = { $lte: mongoose.Types.ObjectId('minStockLevel') };
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

// Create a single inventory item
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء عنصر مخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 0, maxStockLevel = 1000, orderId } = req.body;

    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      console.log('إنشاء عنصر مخزون - بيانات غير صالحة:', { branchId, productId, userId, currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('إنشاء عنصر مخزون - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء عنصر مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

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
      },
      { upsert: true, new: true, session }
    );

    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      type: 'restock',
      quantity: currentStock,
      reference,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

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
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, userId, orderId, items } = req.body;

    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      console.log('إنشاء دفعة مخزون - بيانات غير صالحة:', { branchId, userId, items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، المستخدم، أو العناصر غير صالحة' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('إنشاء دفعة مخزون - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء دفعة مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    const [branch, order] = await Promise.all([
      Branch.findById(branchId).session(session),
      orderId ? Order.findById(orderId).session(session) : Promise.resolve(null),
    ]);
    if (!branch) {
      console.log('إنشاء دفعة مخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }
    if (orderId && !order) {
      console.log('إنشاء دفعة مخزون - الطلب غير موجود:', { orderId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderId && order && order.status !== 'delivered') {
      console.log('إنشاء دفعة مخزون - حالة الطلب غير صالحة:', { orderId, status: order.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن تكون الطلبية في حالة "تم التسليم"' });
    }

    const productIds = items.map(item => item.productId).filter(id => isValidObjectId(id));
    if (productIds.length !== items.length) {
      console.log('إنشاء دفعة مخزون - معرفات منتجات غير صالحة:', { invalidIds: items.map(item => item.productId) });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرفات المنتجات غير صالحة' });
    }

    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      console.log('إنشاء دفعة مخزون - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'بعض المنتجات غير موجودة' });
    }

    const reference = orderId
      ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
      : `إنشاء دفعة مخزون بواسطة ${req.user.username}`;

    const inventories = [];
    const historyEntries = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 0, maxStockLevel = 1000 } = item;
      if (currentStock < 0) {
        console.log('إنشاء دفعة مخزون - كمية غير صالحة:', { productId, currentStock });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير صالحة للمنتج ${productId}` });
      }

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
        },
        { upsert: true, new: true, session }
      );

      inventories.push(inventory);

      const historyEntry = new InventoryHistory({
        product: productId,
        branch: branchId,
        type: 'restock',
        quantity: currentStock,
        reference,
        createdBy: userId,
      });
      historyEntries.push(historyEntry);

      req.io?.emit('inventoryUpdated', {
        branchId,
        productId,
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
      });
    }

    await InventoryHistory.insertMany(historyEntries, { session });

    const populatedItems = await Inventory.find({ _id: { $in: inventories.map(inv => inv._id) } })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    console.log('إنشاء دفعة مخزون - تم بنجاح:', {
      count: inventories.length,
      branchId,
      userId,
      orderId,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: populatedItems });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء دفعة مخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Update inventory stock
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث المخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel } = req.body;

    if (!isValidObjectId(id)) {
      console.log('تحديث المخزون - معرف غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث المخزون - العنصر غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    const oldStock = inventory.currentStock;
    if (currentStock !== undefined) {
      inventory.currentStock = currentStock;
    }
    if (minStockLevel !== undefined) {
      inventory.minStockLevel = minStockLevel;
    }
    if (maxStockLevel !== undefined) {
      inventory.maxStockLevel = maxStockLevel;
    }
    if (currentStock !== undefined) {
      inventory.movements.push({
        type: currentStock > oldStock ? 'in' : 'out',
        quantity: Math.abs(currentStock - oldStock),
        reference: `تحديث المخزون بواسطة ${req.user.username}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
    }

    await inventory.save({ session });

    if (currentStock !== undefined) {
      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        type: 'adjustment',
        quantity: Math.abs(currentStock - oldStock),
        reference: `تحديث المخزون بواسطة ${req.user.username}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      req.io?.emit('inventoryUpdated', {
        branchId: inventory.branch.toString(),
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        type: 'adjustment',
      });
    }

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: inventory._id,
      productId: inventory.product,
      branchId: inventory.branch,
      currentStock: inventory.currentStock,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Update stock limits
const updateStockLimits = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث حدود المخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { minStockLevel, maxStockLevel } = req.body;

    if (!isValidObjectId(id)) {
      console.log('تحديث حدود المخزون - معرف غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    if (maxStockLevel <= minStockLevel) {
      console.log('تحديث حدود المخزون - حدود غير صالحة:', { minStockLevel, maxStockLevel });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث حدود المخزون - العنصر غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث حدود المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    inventory.minStockLevel = minStockLevel;
    inventory.maxStockLevel = maxStockLevel;
    await inventory.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      minStockLevel,
      maxStockLevel,
      type: 'limits_update',
    });

    console.log('تحديث حدود المخزون - تم بنجاح:', {
      inventoryId: inventory._id,
      minStockLevel,
      maxStockLevel,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث حدود المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Create a return
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء مرتجع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, items, reason, orderId, notes } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !Array.isArray(items) || items.length === 0 || !reason) {
      console.log('إنشاء مرتجع - بيانات غير صالحة:', { branchId, items, reason });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، العناصر، أو السبب مطلوب' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مرتجع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مرتجع لهذا الفرع' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('إنشاء مرتجع - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log('إنشاء مرتجع - معرف الطلب غير صالح:', { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log('إنشاء مرتجع - الطلب غير موجود:', { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
    }

    for (const item of items) {
      if (!isValidObjectId(item.productId) || item.quantity < 1 || !item.reason) {
        console.log('إنشاء مرتجع - بيانات عنصر غير صالحة:', { item });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }

      const inventory = await Inventory.findOne({ product: item.productId, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء مرتجع - الكمية غير كافية:', { productId: item.productId, currentStock: inventory?.currentStock, requested: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.productId}` });
      }

      inventory.currentStock -= item.quantity;
      inventory.movements.push({
        type: 'out',
        quantity: item.quantity,
        reference: `مرتجع: ${reason}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
      await inventory.save({ session });

      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: branchId,
        type: 'return',
        quantity: item.quantity,
        reference: `مرتجع: ${reason}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      req.io?.emit('inventoryUpdated', {
        branchId,
        productId: item.productId,
        quantity: inventory.currentStock,
        type: 'return',
        reference: `مرتجع: ${reason}`,
      });
    }

    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(returnCount + 1).padStart(3, '0')}`;

    const newReturn = new Return({
      returnNumber,
      branch: branchId,
      order: orderId,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason,
      })),
      reason,
      notes: notes?.trim(),
      status: 'pending_approval',
      createdBy: req.user.id,
    });
    await newReturn.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedItems = populatedReturn.items.map(item => ({
      ...item,
      productName: isRtl ? item.product.name : item.product.nameEn,
      unit: isRtl ? item.product.unit : item.product.unitEn,
      departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn,
    }));

    req.io?.to(`branch-${branchId}`).emit('returnCreated', {
      returnId: newReturn._id,
      branchId,
      status: 'pending_approval',
      items: formattedItems,
    });

    console.log('إنشاء مرتجع - تم بنجاح:', {
      returnId: newReturn._id,
      branchId,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      returnRequest: {
        ...populatedReturn,
        items: formattedItems,
        createdByName: isRtl ? populatedReturn.createdBy.name : populatedReturn.createdBy.nameEn,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء المرتجع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get returns
const getReturns = async (req, res) => {
  try {
    const { branchId, status, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const query = {};
    if (branchId && isValidObjectId(branchId)) query.branch = branchId;
    if (req.user.role === 'branch' && !branchId) query.branch = req.user.branchId;
    if (status) query.status = status;

    if (req.user.role === 'branch' && branchId && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المرتجعات - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مرتجعات هذا الفرع' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [returns, totalItems] = await Promise.all([
      Return.find(query)
        .populate('branch', 'name nameEn')
        .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
        .populate('createdBy', 'name nameEn')
        .populate('reviewedBy', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Return.countDocuments(query),
    ]);

    const formattedReturns = returns.map(ret => ({
      ...ret,
      branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn,
      items: ret.items.map(item => ({
        ...item,
        productName: isRtl ? item.product.name : item.product.nameEn,
        unit: isRtl ? item.product.unit : item.product.unitEn,
        departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn,
      })),
      createdByName: isRtl ? ret.createdBy?.name : ret.createdBy?.nameEn,
      reviewedByName: ret.reviewedBy ? (isRtl ? ret.reviewedBy.name : ret.reviewedBy.nameEn) : null,
    }));

    console.log('جلب المرتجعات - تم بنجاح:', {
      count: returns.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({
      success: true,
      returns: formattedReturns,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب المرتجعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Approve or reject a return
const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('الموافقة على المرتجع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { status, reviewNotes } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id)) {
      console.log('الموافقة على المرتجع - معرف غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المرتجع غير صالح' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      console.log('الموافقة على المرتجع - حالة غير صالحة:', { status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة المرتجع غير صالحة' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      console.log('الموافقة على المرتجع - غير مخول:', { userId: req.user.id });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على المرتجعات' });
    }

    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      console.log('الموافقة على المرتجع - المرتجع غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المرتجع غير موجود' });
    }

    if (returnRequest.status !== 'pending_approval') {
      console.log('الموافقة على المرتجع - الحالة غير صالحة:', { id, status: returnRequest.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المرتجع ليس في انتظار الموافقة' });
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    await returnRequest.save({ session });

    if (status === 'rejected') {
      for (const item of returnRequest.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: returnRequest.branch },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `رفض مرتجع ${returnRequest.returnNumber} بواسطة ${req.user.username}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
  branch: returnRequest.branch,
  type: 'adjustment',
  quantity: item.quantity,
  reference: `رفض مرتجع ${returnRequest.returnNumber} بواسطة ${req.user.username}`,
  createdBy: req.user.id,
});
await historyEntry.save({ session });

req.io?.emit('inventoryUpdated', {
  branchId: returnRequest.branch.toString(),
  productId: item.product.toString(),
  quantity: inventory.currentStock,
  type: 'adjustment',
  reference: `رفض مرتجع ${returnRequest.returnNumber}`,
});
}
}

const populatedReturn = await Return.findById(returnRequest._id)
.populate('branch', 'name nameEn')
.populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
.populate('createdBy', 'name nameEn')
.populate('reviewedBy', 'name nameEn')
.session(session)
.lean();

const formattedReturn = {
...populatedReturn,
branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn,
items: populatedReturn.items.map(item => ({
  ...item,
  productName: isRtl ? item.product.name : item.product.nameEn,
  unit: isRtl ? item.product.unit : item.product.unitEn,
  departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn,
})),
createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn,
reviewedByName: isRtl ? populatedReturn.reviewedBy?.name : populatedReturn.reviewedBy?.nameEn,
};

req.io?.to(`branch-${returnRequest.branch.toString()}`).emit('returnUpdated', {
returnId: returnRequest._id,
branchId: returnRequest.branch.toString(),
status,
items: formattedReturn.items,
});

console.log('الموافقة على المرتجع - تم بنجاح:', {
returnId: returnRequest._id,
status,
userId: req.user.id,
});

await session.commitTransaction();
res.status(200).json({
success: true,
returnRequest: formattedReturn,
});
} catch (err) {
await session.abortTransaction();
console.error('خطأ في معالجة المرتجع:', { error: err.message, stack: err.stack, requestBody: req.body });
res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
} finally {
session.endSession();
}
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
try {
const { branchId, productId, page = 1, limit = 10 } = req.query;
const lang = req.query.lang || 'ar';
const isRtl = lang === 'ar';

const query = {};
if (branchId && isValidObjectId(branchId)) {
query.branch = branchId;
} else if (req.user.role === 'branch') {
if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
  console.log('جلب سجل المخزون - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
  return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
}
query.branch = req.user.branchId;
}
if (productId && isValidObjectId(productId)) {
query.product = productId;
}

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
  .populate('transferDetails.fromBranch', 'name nameEn')
  .populate('transferDetails.toBranch', 'name nameEn')
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
fromBranchName: item.transferDetails?.fromBranch ? (isRtl ? item.transferDetails.fromBranch.name : item.transferDetails.fromBranch.nameEn) : null,
toBranchName: item.transferDetails?.toBranch ? (isRtl ? item.transferDetails.toBranch.name : item.transferDetails.toBranch.nameEn) : null,
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

// Get product details, movements, transfers, and statistics
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
  .populate('transferDetails.fromBranch', 'name nameEn')
  .populate('transferDetails.toBranch', 'name nameEn')
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
createInventory,
updateStock,
updateStockLimits,
bulkCreate,
createReturn,
getReturns,
approveReturn,
getInventoryHistory,
getProductDetails,
};