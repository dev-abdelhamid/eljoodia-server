const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const RestockRequest = require('../models/RestockRequest');
const createNotification = require('../utils/notification');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

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

    const skip = (page - 1) * limit;
    const inventoryItems = await Inventory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .skip(skip)
      .limit(limit)
      .lean();

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    const totalItems = await Inventory.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    console.log('جلب المخزون - تم بنجاح:', {
      count: filteredItems.length,
      userId: req.user.id,
      query,
      page,
      limit,
    });

    res.status(200).json({ success: true, inventory: filteredItems, totalPages, currentPage: Number(page) });
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }

    const skip = (page - 1) * limit;
    const inventoryItems = await Inventory.find({ branch: branchId })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .skip(skip)
      .limit(limit)
      .lean();

    const totalItems = await Inventory.countDocuments({ branch: branchId });
    const totalPages = Math.ceil(totalItems / limit);

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
      page,
      limit,
    });

    res.status(200).json({ success: true, inventory: inventoryItems, totalPages, currentPage: Number(page) });
  } catch (err) {
    console.error('خطأ في جلب المخزون حسب الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

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
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

    if (!id && (!isValidObjectId(productId) || !isValidObjectId(branchId))) {
      console.log('تحديث المخزون - معرفات غير صالحة:', { productId, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان إذا لم يتم توفير معرف المخزون' });
    }

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
    if (id) {
      inventory = await Inventory.findById(id).session(session);
      if (!inventory) {
        console.log('تحديث المخزون - العنصر غير موجود:', { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
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
    } else {
      inventory = new Inventory({
        product: productId,
        branch: branchId,
        currentStock: currentStock || 0,
        minStockLevel: minStockLevel || 0,
        maxStockLevel: maxStockLevel || 1000,
        createdBy: req.user.id,
        movements: [{
          type: 'in',
          quantity: currentStock || 0,
          reference: `إنشاء مخزون بواسطة ${req.user.username}`,
          createdBy: req.user.id,
          createdAt: new Date(),
        }],
      });
    }

    await inventory.save({ session });

    if (currentStock !== undefined) {
      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        action: id ? 'adjustment' : 'restock',
        quantity: currentStock || 0,
        reference: `تحديث المخزون بواسطة ${req.user.username}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    if (currentStock !== undefined || minStockLevel !== undefined || maxStockLevel !== undefined) {
      req.io?.emit('inventoryUpdated', {
        branchId: inventory.branch.toString(),
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        minStockLevel: inventory.minStockLevel,
        maxStockLevel: inventory.maxStockLevel,
        type: id ? 'adjustment' : 'restock',
      });
    }

    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: inventory._id,
      productId: inventory.product,
      branchId: inventory.branch,
      currentStock: inventory.currentStock,
      minStockLevel,
      maxStockLevel,
    });

    await session.commitTransaction();
    res.status(id ? 200 : 201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

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
    const { minStockLevel, maxStockLevel, branchId } = req.body;

    if (!isValidObjectId(id) || !isValidObjectId(branchId)) {
      console.log('تحديث حدود المخزون - معرفات غير صالحة:', { id, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون أو الفرع غير صالح' });
    }

    if (maxStockLevel <= minStockLevel) {
      console.log('تحديث حدود المخزون - الحد الأقصى أقل من أو يساوي الحد الأدنى:', { minStockLevel, maxStockLevel });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('تحديث حدود المخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('تحديث حدود المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حدود مخزون هذا الفرع' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث حدود المخزون - العنصر غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
    }

    inventory.minStockLevel = minStockLevel;
    inventory.maxStockLevel = maxStockLevel;
    inventory.updatedAt = new Date();
    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      product: inventory.product,
      branch: inventory.branch,
      action: 'limits_adjustment',
      quantity: 0,
      reference: `تعديل حدود المخزون (الحد الأدنى: ${minStockLevel}, الحد الأقصى: ${maxStockLevel}) بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      minStockLevel: inventory.minStockLevel,
      maxStockLevel: inventory.maxStockLevel,
      type: 'limits_adjustment',
    });

    console.log('تحديث حدود المخزون - تم بنجاح:', {
      inventoryId: inventory._id,
      productId: inventory.product,
      branchId: inventory.branch,
      minStockLevel,
      maxStockLevel,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث حدود المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

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
      action: 'restock',
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
      minStockLevel: inventory.minStockLevel,
      maxStockLevel: inventory.maxStockLevel,
      type: 'restock',
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
        action: 'restock',
        quantity: currentStock,
        reference,
        createdBy: userId,
      });
      historyEntries.push(historyEntry);

      req.io?.emit('inventoryUpdated', {
        branchId,
        productId,
        quantity: inventory.currentStock,
        minStockLevel,
        maxStockLevel,
        type: 'restock',
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

const createRestockRequest = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء طلب إعادة التخزين - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId, requestedQuantity, notes } = req.body;

    if (!isValidObjectId(productId) || !isValidObjectId(branchId) || requestedQuantity < 1) {
      console.log('إنشاء طلب إعادة التخزين - بيانات غير صالحة:', { productId, branchId, requestedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج، الفرع، أو الكمية المطلوبة غير صالحة' });
    }

    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log('إنشاء طلب إعادة التخزين - المنتج غير موجود:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log('إنشاء طلب إعادة التخزين - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء طلب إعادة التخزين - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إعادة تخزين لهذا الفرع' });
    }

    const restockRequest = new RestockRequest({
      product: productId,
      branch: branchId,
      requestedQuantity,
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await restockRequest.save({ session });

    const populatedRequest = await RestockRequest.findById(restockRequest._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    req.io?.emit('restockRequested', {
      requestId: restockRequest._id,
      branchId,
      productId,
      requestedQuantity,
    });

    console.log('إنشاء طلب إعادة التخزين - تم بنجاح:', {
      requestId: restockRequest._id,
      productId,
      branchId,
      requestedQuantity,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, restockRequest: populatedRequest });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء طلب إعادة التخزين:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveRestockRequest = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تأكيد طلب إعادة التخزين - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { requestId } = req.params;
    const { approvedQuantity, userId } = req.body;

    if (!isValidObjectId(requestId) || !isValidObjectId(userId) || approvedQuantity < 1) {
      console.log('تأكيد طلب إعادة التخزين - بيانات غير صالحة:', { requestId, userId, approvedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب، المستخدم، أو الكمية المعتمدة غير صالحة' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('تأكيد طلب إعادة التخزين - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const restockRequest = await RestockRequest.findById(requestId).session(session);
    if (!restockRequest) {
      console.log('تأكيد طلب إعادة التخزين - الطلب غير موجود:', { requestId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب إعادة التخزين غير موجود' });
    }

    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = userId;
    restockRequest.approvedAt = new Date();
    await restockRequest.save({ session });

    const inventory = await Inventory.findOneAndUpdate(
      { product: restockRequest.product, branch: restockRequest.branch },
      {
        $setOnInsert: {
          product: restockRequest.product,
          branch: restockRequest.branch,
          minStockLevel: 0,
          maxStockLevel: 1000,
          createdBy: userId,
        },
        $inc: { currentStock: approvedQuantity },
        $push: {
          movements: {
            type: 'in',
            quantity: approvedQuantity,
            reference: `إعادة تخزين معتمدة #${restockRequest._id} بواسطة ${req.user.username}`,
            createdBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { upsert: true, new: true, session }
    );

    const historyEntry = new InventoryHistory({
      product: restockRequest.product,
      branch: restockRequest.branch,
      action: 'restock',
      quantity: approvedQuantity,
      reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    const populatedRequest = await RestockRequest.findById(requestId)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .populate('approvedBy', 'username')
      .session(session)
      .lean();

    req.io?.emit('restockApproved', {
      requestId,
      branchId: restockRequest.branch.toString(),
      productId: restockRequest.product.toString(),
      quantity: approvedQuantity,
    });
    req.io?.emit('inventoryUpdated', {
      branchId: restockRequest.branch.toString(),
      productId: restockRequest.product.toString(),
      quantity: inventory.currentStock,
      minStockLevel: inventory.minStockLevel,
      maxStockLevel: inventory.maxStockLevel,
      type: 'restock',
    });

    console.log('تأكيد طلب إعادة التخزين - تم بنجاح:', {
      requestId,
      productId: restockRequest.product,
      branchId: restockRequest.branch,
      approvedQuantity,
      userId,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, restockRequest: populatedRequest });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تأكيد طلب إعادة التخزين:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getRestockRequests = async (req, res) => {
  try {
    const { branchId, page = 1, limit = 10 } = req.query;
    const query = {};

    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب طلبات إعادة التخزين - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    const skip = (page - 1) * limit;
    const restockRequests = await RestockRequest.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const totalItems = await RestockRequest.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    console.log('جلب طلبات إعادة التخزين - تم بنجاح:', {
      count: restockRequests.length,
      userId: req.user.id,
      query,
      page,
      limit,
    });

    res.status(200).json({ success: true, restockRequests, totalPages, currentPage: Number(page) });
  } catch (err) {
    console.error('خطأ في جلب طلبات إعادة التخزين:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getInventoryHistory = async (req, res) => {
  try {
    const { branchId, productId, page = 1, limit = 10 } = req.query;
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

    const skip = (page - 1) * limit;
    const history = await InventoryHistory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const totalItems = await InventoryHistory.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    console.log('جلب سجل المخزون - تم بنجاح:', {
      count: history.length,
      userId: req.user.id,
      query,
      page,
      limit,
    });

    res.status(200).json({ success: true, history, totalPages, currentPage: Number(page) });
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء طلب إرجاع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { orderId, items, reason, notes, branchId } = req.body;

    if (!isValidObjectId(branchId) || !items?.length || !reason) {
      console.log('إنشاء طلب إرجاع - بيانات غير صالحة:', { branchId, items, reason });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، العناصر، أو السبب غير صالحة' });
    }

    let order = null;
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log('إنشاء طلب إرجاع - معرف الطلب غير صالح:', { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
      }
      order = await Order.findById(orderId).populate('branch').session(session);
      if (!order) {
        console.log('إنشاء طلب إرجاع - الطلب غير موجود:', { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        console.log('إنشاء طلب إرجاع - حالة الطلب غير صالحة:', { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم"' });
      }
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء طلب إرجاع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إرجاع لهذا الفرع' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.productId) || item.quantity < 1 || !item.reason) {
        console.log('إنشاء طلب إرجاع - عنصر غير صالح:', { productId: item.productId, quantity: item.quantity, reason: item.reason });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `عنصر غير صالح: ${item.productId}` });
      }

      const product = await Product.findById(item.productId).session(session);
      if (!product) {
        console.log('إنشاء طلب إرجاع - المنتج غير موجود:', { productId: item.productId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: `المنتج ${item.productId} غير موجود` });
      }

      const inventoryItem = await Inventory.findOne({ product: item.productId, branch: branchId }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        console.log('إنشاء طلب إرجاع - الكمية غير كافية:', {
          productId: item.productId,
          currentStock: inventoryItem?.currentStock,
          requestedQuantity: item.quantity,
        });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.productId}` });
      }

      if (orderId) {
        const orderItem = order.items.find(i => i.product.toString() === item.productId);
        if (!orderItem || (orderItem.quantity - (orderItem.returnedQuantity || 0)) < item.quantity) {
          console.log('إنشاء طلب إرجاع - الكمية المرتجعة غير صالحة:', {
            productId: item.productId,
            orderQuantity: orderItem?.quantity,
            returnedQuantity: orderItem?.returnedQuantity,
            requestedQuantity: item.quantity,
          });
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: `الكمية المرتجعة غير صالحة للمنتج ${item.productId}` });
        }
      }
    }

    const returnNumber = `RET-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const returnRequest = new Return({
      returnNumber,
      order: orderId || null,
      branch: branchId,
      reason,
      items: items.map(item => ({
        itemId: orderId ? order.items.find(i => i.product.toString() === item.productId)?._id : null,
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason,
      })),
      notes: notes?.trim(),
      createdBy: req.user.id,
      status: 'pending_approval',
    });

    await returnRequest.save({ session });

    for (const item of items) {
      await Inventory.findOneAndUpdate(
        { product: item.productId, branch: branchId },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'out',
              quantity: item.quantity,
              reference: `إرجاع #${returnNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { session }
      );

      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: branchId,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `إرجاع #${returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      if (orderId) {
        const orderItem = order.items.find(i => i.product.toString() === item.productId);
        if (orderItem) {
          orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
          orderItem.returnReason = item.reason;
        }
      }
    }

    if (orderId) {
      order.returns.push(returnRequest._id);
      await order.save({ session });
    }

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('order', 'orderNumber totalAmount adjustedTotal branch')
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();

    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const formattedReturn = {
      ...populatedReturn,
      branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn || populatedReturn.branch?.name,
      reason: populatedReturn.reason,
      items: populatedReturn.items.map(item => ({
        ...item,
        product: {
          _id: item.product._id,
          name: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          department: item.product?.department
            ? {
                _id: item.product.department._id,
                name: isRtl ? item.product.department?.name : item.product.department?.nameEn || item.product.department?.name,
              }
            : null,
        },
        reason: item.reason,
      })),
      createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name,
    };

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: branchId },
      ],
    }).select('_id role').lean();

    await Promise.all(usersToNotify.map(async (user) => {
      try {
        await createNotification(
          user._id,
          'return_created',
          'notifications.return_created',
          {
            returnId: returnRequest._id,
            orderId: orderId || null,
            orderNumber: order ? order.orderNumber : 'No Order',
            branchId,
            eventId: `${returnRequest._id}-return_created`,
          },
          io
        );
        console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for return creation`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for return creation:`, err.message);
      }
    }));

    io?.emit('returnCreated', {
      returnId: returnRequest._id,
      branchId,
      orderId: orderId || null,
      reason,
      items: formattedReturn.items,
      status: returnRequest.status,
      createdAt: new Date().toISOString(),
      eventId: `${returnRequest._id}-return_created`,
    });

    console.log('إنشاء طلب إرجاع - تم بنجاح:', {
      returnId: returnRequest._id,
      branchId,
      orderId,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, returnRequest: formattedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء طلب إرجاع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const processReturnItems = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('معالجة طلب إرجاع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { returnId } = req.params;
    const { branchId, items } = req.body;

    if (!isValidObjectId(returnId) || !isValidObjectId(branchId) || !items?.length) {
      console.log('معالجة طلب إرجاع - بيانات غير صالحة:', { returnId, branchId, items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الإرجاع، الفرع، أو العناصر غير صالحة' });
    }

    const returnRequest = await Return.findById(returnId).session(session);
    if (!returnRequest) {
      console.log('معالجة طلب إرجاع - الإرجاع غير موجود:', { returnId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب الإرجاع غير موجود' });
    }

    if (returnRequest.status !== 'pending_approval') {
      console.log('معالجة طلب إرجاع - حالة غير صالحة:', { returnId, status: returnRequest.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'طلب الإرجاع ليس في حالة "في انتظار الموافقة"' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('معالجة طلب إرجاع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لمعالجة طلب إرجاع لهذا الفرع' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.productId) || item.quantity < 1 || !['approved', 'rejected'].includes(item.status)) {
        console.log('معالجة طلب إرجاع - عنصر غير صالح:', { productId: item.productId, quantity: item.quantity, status: item.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `عنصر غير صالح: ${item.productId}` });
      }

      const returnItem = returnRequest.items.find(i => i.product.toString() === item.productId);
      if (!returnItem || returnItem.quantity !== item.quantity) {
        console.log('معالجة طلب إرجاع - العنصر أو الكمية غير متطابقة:', {
          productId: item.productId,
          returnQuantity: returnItem?.quantity,
          requestedQuantity: item.quantity,
        });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `عنصر أو كمية غير متطابقة: ${item.productId}` });
      }

      returnItem.status = item.status;
      returnItem.reviewNotes = item.reviewNotes?.trim();
    }

    const allApproved = returnRequest.items.every(i => i.status === 'approved');
    const allRejected = returnRequest.items.every(i => i.status === 'rejected');
    returnRequest.status = allApproved ? 'approved' : allRejected ? 'rejected' : 'partially_processed';
    returnRequest.processedBy = req.user.id;
    returnRequest.processedAt = new Date();
    await returnRequest.save({ session });

    for (const item of items) {
      if (item.status === 'rejected') {
        await Inventory.findOneAndUpdate(
          { product: item.productId, branch: branchId },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `رفض إرجاع #${returnRequest.returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: branchId,
          action: 'return_rejected',
          quantity: item.quantity,
          reference: `رفض إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });
      }
    }

    if (returnRequest.order) {
      const order = await Order.findById(returnRequest.order).session(session);
      if (order) {
        for (const item of items) {
          const orderItem = order.items.find(i => i.product.toString() === item.productId);
          if (orderItem && item.status === 'approved') {
            orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
          }
        }
        await order.save({ session });
      }
    }

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('order', 'orderNumber totalAmount adjustedTotal branch')
      .populate('branch', 'name nameEn')
      .populate({
        path:'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .populate('processedBy', 'username name nameEn')
      .session(session)
      .lean();

    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const formattedReturn = {
      ...populatedReturn,
      branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn || populatedReturn.branch?.name,
      reason: populatedReturn.reason,
      items: populatedReturn.items.map(item => ({
        ...item,
        product: {
          _id: item.product._id,
          name: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          department: item.product?.department
            ? {
                _id: item.product.department._id,
                name: isRtl ? item.product.department?.name : item.product.department?.nameEn || item.product.department?.name,
              }
            : null,
        },
        reason: item.reason,
      })),
      createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name,
      processedByName: isRtl ? populatedReturn.processedBy?.name : populatedReturn.processedBy?.nameEn || populatedReturn.processedBy?.name,
    };

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: branchId },
      ],
    }).select('_id role').lean();

    await Promise.all(usersToNotify.map(async (user) => {
      try {
        await createNotification(
          user._id,
          'return_status_updated',
          'notifications.return_status_updated',
          {
            returnId: returnRequest._id,
            orderId: returnRequest.order || null,
            orderNumber: returnRequest.order ? (await Order.findById(returnRequest.order))?.orderNumber : 'No Order',
            branchId,
            status: returnRequest.status,
            eventId: `${returnRequest._id}-return_status_updated`,
          },
          io
        );
        console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for return status update`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for return status update:`, err.message);
      }
    }));

    io?.emit('returnStatusUpdated', {
      returnId: returnRequest._id,
      branchId,
      orderId: returnRequest.order || null,
      status: returnRequest.status,
      items: formattedReturn.items,
      processedAt: new Date().toISOString(),
      eventId: `${returnRequest._id}-return_status_updated`,
    });

    for (const item of items) {
      if (item.status === 'approved') {
        req.io?.emit('inventoryUpdated', {
          branchId,
          productId: item.productId,
          quantity: item.quantity,
          type: 'return_approved',
        });
      } else if (item.status === 'rejected') {
        req.io?.emit('inventoryUpdated', {
          branchId,
          productId: item.productId,
          quantity: item.quantity,
          type: 'return_rejected',
        });
      }
    }

    console.log('معالجة طلب إرجاع - تم بنجاح:', {
      returnId: returnRequest._id,
      branchId,
      userId: req.user.id,
      status: returnRequest.status,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, returnRequest: formattedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في معالجة طلب إرجاع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getReturns = async (req, res) => {
  try {
    const { branchId, status, page = 1, limit = 10 } = req.query;
    const query = {};

    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب طلبات الإرجاع - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    if (status) {
      query.status = status;
    }

    const skip = (page - 1) * limit;
    const returns = await Return.find(query)
      .populate('order', 'orderNumber totalAmount adjustedTotal branch')
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .populate('processedBy', 'username name nameEn')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const formattedReturns = returns.map(returnRequest => ({
      ...returnRequest,
      branchName: isRtl ? returnRequest.branch?.name : returnRequest.branch?.nameEn || returnRequest.branch?.name,
      reason: returnRequest.reason,
      items: returnRequest.items.map(item => ({
        ...item,
        product: {
          _id: item.product._id,
          name: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          department: item.product?.department
            ? {
                _id: item.product.department._id,
                name: isRtl ? item.product.department?.name : item.product.department?.nameEn || item.product.department?.name,
              }
            : null,
        },
        reason: item.reason,
      })),
      createdByName: isRtl ? returnRequest.createdBy?.name : returnRequest.createdBy?.nameEn || returnRequest.createdBy?.name,
      processedByName: isRtl
        ? returnRequest.processedBy?.name
        : returnRequest.processedBy?.nameEn || returnRequest.processedBy?.name || null,
    }));

    const totalItems = await Return.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    console.log('جلب طلبات الإرجاع - تم بنجاح:', {
      count: formattedReturns.length,
      userId: req.user.id,
      query,
      page,
      limit,
    });

    res.status(200).json({ success: true, returns: formattedReturns, totalPages, currentPage: Number(page) });
  } catch (err) {
    console.error('خطأ في جلب طلبات الإرجاع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getReturnById = async (req, res) => {
  try {
    const { returnId } = req.params;

    if (!isValidObjectId(returnId)) {
      console.log('جلب طلب إرجاع - معرف الإرجاع غير صالح:', { returnId });
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(returnId)
      .populate('order', 'orderNumber totalAmount adjustedTotal branch')
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .populate('processedBy', 'username name nameEn')
      .lean();

    if (!returnRequest) {
      console.log('جلب طلب إرجاع - الإرجاع غير موجود:', { returnId });
      return res.status(404).json({ success: false, message: 'طلب الإرجاع غير موجود' });
    }

    if (req.user.role === 'branch' && returnRequest.branch.toString() !== req.user.branchId?.toString()) {
      console.log('جلب طلب إرجاع - غير مخول:', {
        userId: req.user.id,
        branchId: returnRequest.branch,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى طلب الإرجاع لهذا الفرع' });
    }

    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const formattedReturn = {
      ...returnRequest,
      branchName: isRtl ? returnRequest.branch?.name : returnRequest.branch?.nameEn || returnRequest.branch?.name,
      reason: returnRequest.reason,
      items: returnRequest.items.map(item => ({
        ...item,
        product: {
          _id: item.product._id,
          name: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          department: item.product?.department
            ? {
                _id: item.product.department._id,
                name: isRtl ? item.product.department?.name : item.product.department?.nameEn || item.product.department?.name,
              }
            : null,
        },
        reason: item.reason,
      })),
      createdByName: isRtl ? returnRequest.createdBy?.name : returnRequest.createdBy?.nameEn || returnRequest.createdBy?.name,
      processedByName: isRtl
        ? returnRequest.processedBy?.name
        : returnRequest.processedBy?.nameEn || returnRequest.processedBy?.name || null,
    };

    console.log('جلب طلب إرجاع - تم بنجاح:', {
      returnId,
      userId: req.user.id,
    });

    res.status(200).json({ success: true, returnRequest: formattedReturn });
  } catch (err) {
    console.error('خطأ في جلب طلب إرجاع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  getInventory,
  getInventoryByBranch,
  updateStock,
  updateStockLimits,
  createInventory,
  bulkCreate,
  createRestockRequest,
  approveRestockRequest,
  getRestockRequests,
  getInventoryHistory,
  createReturn,
  processReturnItems,
  getReturns,
  getReturnById,
};