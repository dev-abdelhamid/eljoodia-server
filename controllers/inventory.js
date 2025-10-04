// controllers/inventory.js
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

// Create or update inventory item
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
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
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
      type: 'restock',
      quantity: currentStock,
      reference,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    // Populate response
    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
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
      return res.status(400).json({ success: false, errors: errors.array() });
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
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
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
        type: 'restock',
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

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock } = req.query;
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

    const inventoryItems = await Inventory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .lean();

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    console.log('جلب المخزون - تم بنجاح:', {
      count: filteredItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, inventory: filteredItems });
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;

    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }

    const inventoryItems = await Inventory.find({ branch: branchId })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .lean();

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
    });

    res.status(200).json({ success: true, inventory: inventoryItems });
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
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

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

    // Log to InventoryHistory if stock changed
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

    // Populate response
    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    // Emit inventory update event if stock changed
    if (currentStock !== undefined) {
      req.io?.emit('inventoryUpdated', {
        branchId: inventory.branch.toString(),
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        type: id ? 'adjustment' : 'restock',
      });
    }

    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: inventory._id,
      productId: inventory.product,
      branchId: inventory.branch,
      currentStock: inventory.currentStock,
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

// Create restock request
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

    // Validate inputs
    if (!isValidObjectId(productId) || !isValidObjectId(branchId) || requestedQuantity < 1) {
      console.log('إنشاء طلب إعادة التخزين - بيانات غير صالحة:', { productId, branchId, requestedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج، الفرع، أو الكمية المطلوبة غير صالحة' });
    }

    // Validate product and branch
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

    const restockRequest = new mongoose.model('RestockRequest')({
      product: productId,
      branch: branchId,
      requestedQuantity,
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await restockRequest.save({ session });

    // Populate response
    const populatedRequest = await mongoose.model('RestockRequest').findById(restockRequest._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // Emit restock request event
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

// Approve restock request
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

    // Validate inputs
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

    const restockRequest = await mongoose.model('RestockRequest').findById(requestId).session(session);
    if (!restockRequest) {
      console.log('تأكيد طلب إعادة التخزين - الطلب غير موجود:', { requestId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب إعادة التخزين غير موجود' });
    }

    // Update restock request
    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = userId;
    restockRequest.approvedAt = new Date();
    await restockRequest.save({ session });

    // Update inventory
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

    // Log to InventoryHistory
    const historyEntry = new InventoryHistory({
      product: restockRequest.product,
      branch: restockRequest.branch,
      action: 'restock',
      quantity: approvedQuantity,
      reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    // Populate response
    const populatedRequest = await mongoose.model('RestockRequest').findById(requestId)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .populate('approvedBy', 'username')
      .session(session)
      .lean();

    // Emit events
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

// Get restock requests
const getRestockRequests = async (req, res) => {
  try {
    const { branchId } = req.query;
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

    const restockRequests = await mongoose.model('RestockRequest').find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    console.log('جلب طلبات إعادة التخزين - تم بنجاح:', {
      count: restockRequests.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, restockRequests });
  } catch (err) {
    console.error('خطأ في جلب طلبات إعادة التخزين:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const { branchId, productId } = req.query;
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

    const history = await InventoryHistory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    console.log('جلب سجل المخزون - تم بنجاح:', {
      count: history.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, history });
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create return request
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
      if (!isValidObjectId(item.product) || item.quantity < 1 || !item.reason) {
        console.log('إنشاء طلب إرجاع - عنصر غير صالح:', { productId: item.product, quantity: item.quantity, reason: item.reason });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `عنصر غير صالح: ${item.product}` });
      }

      const product = await Product.findById(item.product).session(session);
      if (!product) {
        console.log('إنشاء طلب إرجاع - المنتج غير موجود:', { productId: item.product });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: `المنتج ${item.product} غير موجود` });
      }

      const inventoryItem = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        console.log('إنشاء طلب إرجاع - الكمية غير كافية:', {
          productId: item.product,
          currentStock: inventoryItem?.currentStock,
          requestedQuantity: item.quantity,
        });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.product}` });
      }

      if (orderId) {
        const orderItem = order.items.find(i => i.product.toString() === item.product);
        if (!orderItem || (orderItem.quantity - (orderItem.returnedQuantity || 0)) < item.quantity) {
          console.log('إنشاء طلب إرجاع - الكمية المرتجعة غير صالحة:', {
            productId: item.product,
            orderQuantity: orderItem?.quantity,
            returnedQuantity: orderItem?.returnedQuantity,
            requestedQuantity: item.quantity,
          });
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: `الكمية المرتجعة غير صالحة للمنتج ${item.product}` });
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
        itemId: orderId ? order.items.find(i => i.product.toString() === item.product)?._id : null,
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await returnRequest.save({ session });

    for (const item of items) {
      await Inventory.findOneAndUpdate(
        { product: item.product, branch: branchId },
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
        product: item.product,
        branch: branchId,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `إرجاع #${returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      if (orderId) {
        const orderItem = order.items.find(i => i.product.toString() === item.product);
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
      .populate('order', 'orderNumber')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    req.io?.emit('returnCreated', {
      returnId: returnRequest._id,
      branchId,
      orderId,
      orderNumber: order?.orderNumber,
    });

    console.log('إنشاء طلب إرجاع - تم بنجاح:', {
      returnId: returnRequest._id,
      orderId,
      branchId,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, returnRequest: populatedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء طلب إرجاع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Process return items
const processReturnItems = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('معالجة عناصر الإرجاع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { returnId } = req.params;
    const { branchId, items, status, reviewNotes } = req.body;

    if (!isValidObjectId(returnId) || !isValidObjectId(branchId) || !items?.length || !['approved', 'rejected'].includes(status)) {
      console.log('معالجة عناصر الإرجاع - بيانات غير صالحة:', { returnId, branchId, items, status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الإرجاع، الفرع، العناصر، أو الحالة غير صالحة' });
    }

    const returnRequest = await Return.findById(returnId).session(session);
    if (!returnRequest) {
      console.log('معالجة عناصر الإرجاع - طلب الإرجاع غير موجود:', { returnId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب الإرجاع غير موجود' });
    }

    if (returnRequest.status !== 'pending_approval') {
      console.log('معالجة عناصر الإرجاع - حالة غير صالحة:', { returnId, status: returnRequest.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'طلب الإرجاع ليس في حالة "في انتظار الموافقة"' });
    }

    if (req.user.role === 'branch' && returnRequest.branch.toString() !== req.user.branchId?.toString()) {
      console.log('معالجة عناصر الإرجاع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لمعالجة طلب إرجاع هذا الفرع' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || item.quantity < 1) {
        console.log('معالجة عناصر الإرجاع - عنصر غير صالح:', { productId: item.product, quantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `عنصر غير صالح: ${item.product}` });
      }

      const returnItem = returnRequest.items.find(i => i.product.toString() === item.product);
      if (!returnItem || returnItem.quantity !== item.quantity) {
        console.log('معالجة عناصر الإرجاع - العنصر أو الكمية غير متطابقة:', { productId: item.product, requestedQuantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `عنصر الإرجاع ${item.product} غير موجود أو الكمية غير متطابقة` });
      }
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim() || '';
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();

    if (status === 'approved') {
      for (const item of items) {
        const inventoryItem = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
        if (inventoryItem) {
          await Inventory.findOneAndUpdate(
            { product: item.product, branch: branchId },
            {
              $push: {
                movements: {
                  type: 'return_approved',
                  quantity: -item.quantity,
                  reference: `إرجاع معتمد #${returnRequest.returnNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { session }
          );

          const historyEntry = new InventoryHistory({
            product: item.product,
            branch: branchId,
            action: 'return_approved',
            quantity: -item.quantity,
            reference: `إرجاع معتمد #${returnRequest.returnNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });
        }
      }
    } else if (status === 'rejected') {
      for (const item of items) {
        await Inventory.findOneAndUpdate(
          { product: item.product, branch: branchId },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'return_rejected',
                quantity: item.quantity,
                reference: `إرجاع مرفوض #${returnRequest.returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: branchId,
          action: 'return_rejected',
          quantity: item.quantity,
          reference: `إرجاع مرفوض #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });
      }
    }

    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('order', 'orderNumber')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .session(session)
      .lean();

    req.io?.emit('returnStatusUpdated', {
      returnId: returnRequest._id,
      branchId,
      status,
      eventId: crypto.randomUUID(),
    });

    console.log('معالجة عناصر الإرجاع - تم بنجاح:', {
      returnId,
      branchId,
      status,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, returnRequest: populatedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في معالجة عناصر الإرجاع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Update stock levels
const updateStockLevels = async (req, res) => {
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
      console.log('تحديث حدود المخزون - معرف المخزون غير صالح:', { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    if (minStockLevel < 0 || maxStockLevel < 0 || maxStockLevel <= minStockLevel) {
      console.log('تحديث حدود المخزون - قيم غير صالحة:', { minStockLevel, maxStockLevel });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأدنى والأقصى يجب أن يكونا موجبتين ويجب أن يكون الأقصى أكبر من الأدنى' });
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
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حدود مخزون هذا الفرع' });
    }

    inventory.minStockLevel = minStockLevel;
    inventory.maxStockLevel = maxStockLevel;
    await inventory.save({ session });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      minStockLevel,
      maxStockLevel,
      eventId: crypto.randomUUID(),
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
module.exports = {
  createInventory,
  bulkCreate,
  getInventory,
  getInventoryByBranch,
  updateStock,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createReturn,
  updateStockLevels,
  processReturnItems,
};