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

    const { branchId, productId, userId, currentStock, minStockLevel = 0, maxStockLevel = 1000, orderId } = req.body;

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

    // Validate branch and order
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

    // Validate items
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
        action: 'restock',
        quantity: currentStock,
        reference,
        createdBy: userId,
      });
      historyEntries.push(historyEntry);

      // Emit inventory update event
      req.io?.emit('inventoryUpdated', {
        branchId,
        productId,
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
      });
    }

    await InventoryHistory.insertMany(historyEntries, { session });

    // Populate response
    const populatedItems = await Inventory.find({ _id: { $in: inventories.map(inv => inv._id) } })
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
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

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب المخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branch, product, lowStock, department, lang = 'ar' } = req.query;
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

    if (department && isValidObjectId(department)) {
      const products = await Product.find({ department }).select('_id').lean();
      query.product = { $in: products.map(p => p._id) };
    }

    const inventoryItems = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    const formattedItems = filteredItems.map(item => ({
      ...item,
      product: item.product
        ? {
            ...item.product,
            name: translateField(item.product, 'name', lang),
            unit: translateField(item.product, 'unit', lang),
            department: item.product.department
              ? {
                  ...item.product.department,
                  name: translateField(item.product.department, 'name', lang),
                }
              : null,
          }
        : null,
      branch: item.branch
        ? {
            ...item.branch,
            name: translateField(item.branch, 'name', lang),
          }
        : null,
    }));

    console.log('جلب المخزون - تم بنجاح:', {
      count: formattedItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, inventory: formattedItems });
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
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branchId } = req.params;
    const { department, lang = 'ar' } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }

    const query = { branch: branchId };
    if (department && isValidObjectId(department)) {
      const products = await Product.find({ department }).select('_id').lean();
      query.product = { $in: products.map(p => p._id) };
    }

    const inventoryItems = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    const formattedItems = inventoryItems.map(item => ({
      ...item,
      product: item.product
        ? {
            ...item.product,
            name: translateField(item.product, 'name', lang),
            unit: translateField(item.product, 'unit', lang),
            department: item.product.department
              ? {
                  ...item.product.department,
                  name: translateField(item.product.department, 'name', lang),
                }
              : null,
          }
        : null,
      branch: item.branch
        ? {
            ...item.branch,
            name: translateField(item.branch, 'name', lang),
          }
        : null,
    }));

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', {
      count: formattedItems.length,
      branchId,
      userId: req.user.id,
    });

    res.status(200).json({ success: true, inventory: formattedItems });
  } catch (err) {
    console.error('خطأ في جلب المخزون حسب الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

    if (minStockLevel !== undefined && maxStockLevel !== undefined && minStockLevel >= maxStockLevel) {
      console.log('تحديث المخزون - الحد الأقصى أقل من الحد الأدنى:', { minStockLevel, maxStockLevel });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' });
    }

    if (!id && (!isValidObjectId(productId) || !isValidObjectId(branchId))) {
      console.log('تحديث المخزون - معرفات غير صالحة:', { productId, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان إذا لم يتم توفير معرف المخزون' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId || (await Inventory.findById(id))?.product).session(session),
      Branch.findById(branchId || (await Inventory.findById(id))?.branch).session(session),
    ]);
    if (!product) {
      console.log('تحديث المخزون - المنتج غير موجود:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log('تحديث المخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('تحديث المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    let inventory;
    let isNew = false;
    if (id) {
      inventory = await Inventory.findById(id).session(session);
      if (!inventory) {
        console.log('تحديث المخزون - العنصر غير موجود:', { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
      }
    } else {
      inventory = new Inventory({
        product: productId,
        branch: branchId,
        currentStock: currentStock || 0,
        minStockLevel: minStockLevel || 0,
        maxStockLevel: maxStockLevel || 1000,
        createdBy: req.user.id,
        updatedBy: req.user.id,
        movements: [],
      });
      isNew = true;
    }

    const changes = [];
    let stockChanged = false;
    const oldStock = inventory.currentStock;
    const oldMin = inventory.minStockLevel;
    const oldMax = inventory.maxStockLevel;

    if (currentStock !== undefined && currentStock !== oldStock) {
      changes.push(`currentStock from ${oldStock} to ${currentStock}`);
      inventory.currentStock = currentStock;
      stockChanged = true;
      inventory.movements.push({
        type: currentStock > oldStock ? 'in' : 'out',
        quantity: Math.abs(currentStock - oldStock),
        reference: `تحديث المخزون بواسطة ${req.user.username}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
    }

    if (minStockLevel !== undefined && minStockLevel !== oldMin) {
      changes.push(`minStockLevel from ${oldMin} to ${minStockLevel}`);
      inventory.minStockLevel = minStockLevel;
    }

    if (maxStockLevel !== undefined && maxStockLevel !== oldMax) {
      changes.push(`maxStockLevel from ${oldMax} to ${maxStockLevel}`);
      inventory.maxStockLevel = maxStockLevel;
    }

    if (changes.length > 0 || isNew) {
      inventory.updatedBy = req.user.id;
      await inventory.save({ session });

      const historyAction = stockChanged ? 'adjustment' : 'settings_adjustment';
      const historyQuantity = stockChanged ? (currentStock - oldStock) : 0;

      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        action: historyAction,
        quantity: historyQuantity,
        reference: `تحديث بواسطة ${req.user.username}`,
        createdBy: req.user.id,
        notes: changes.join(', '),
      });
      await historyEntry.save({ session });
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

    // Emit inventory update event if stock changed
    if (changes.length > 0) {
      req.io?.emit('inventoryUpdated', {
        branchId: inventory.branch.toString(),
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        type: stockChanged ? 'adjustment' : 'settings_adjustment',
      });
    }

    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: inventory._id, 
      productId: inventory.product,
      branchId: inventory.branch,
      currentStock: inventory.currentStock,
    });

    await session.commitTransaction();
    res.status(isNew ? 201 : 200).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory history with period filter
const getInventoryHistory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب سجل المخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branchId, productId, department, period, lang = 'ar' } = req.query;
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

    if (department && isValidObjectId(department)) {
      const products = await Product.find({ department }).select('_id').lean();
      query.product = { $in: products.map(p => p._id) };
    }

    if (period) {
      const now = new Date();
      let startDate;
      switch (period) {
        case 'daily':
          startDate = new Date(now.setHours(0, 0, 0, 0));
          break;
        case 'weekly':
          startDate = new Date(now.setDate(now.getDate() - now.getDay()));
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'monthly':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        default:
          return res.status(400).json({ success: false, message: 'الفترة غير صالحة' });
      }
      query.createdAt = { $gte: startDate };
    }

    const history = await InventoryHistory.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'products',
          localField: 'product',
          foreignField: '_id',
          as: 'product'
        }
      },
      { $unwind: '$product' },
      {
        $lookup: {
          from: 'departments',
          localField: 'product.department',
          foreignField: '_id',
          as: 'product.department'
        }
      },
      { $unwind: '$product.department' },
      {
        $lookup: {
          from: 'branches',
          localField: 'branch',
          foreignField: '_id',
          as: 'branch'
        }
      },
      { $unwind: '$branch' },
      {
        $lookup: {
          from: 'users',
          localField: 'createdBy',
          foreignField: '_id',
          as: 'createdBy'
        }
      },
      { $unwind: '$createdBy' },
      { $sort: { createdAt: -1 } }
    ]);

    const formattedHistory = history.map(entry => ({
      ...entry,
      product: entry.product
        ? {
            ...entry.product,
            name: translateField(entry.product, 'name', lang),
            unit: translateField(entry.product, 'unit', lang),
            department: entry.product.department
              ? {
                  ...entry.product.department,
                  name: translateField(entry.product.department, 'name', lang),
                }
              : null,
          }
        : null,
      branch: entry.branch
        ? {
            ...entry.branch,
            name: translateField(entry.branch, 'name', lang),
          }
        : null,
    }));

    console.log('جلب سجل المخزون - تم بنجاح:', {
      count: formattedHistory.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, history: formattedHistory });
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  createInventory,
  bulkCreate,
  getInventory,
  getInventoryByBranch,
  updateStock,
  getInventoryHistory,
};