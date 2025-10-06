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
// دالة للحصول على جميع عناصر المخزون
const getInventory = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'بيانات غير صالحة', errors: errors.array() });
  }
  try {
    const query = {};
    if (req.query.branch) query.branch = req.query.branch;
    if (req.query.product) query.product = req.query.product;
    if (req.user.role === 'branch') query.branch = req.user.branchId;
    const inventory = await Inventory.find(query).populate('product branch');
    res.status(200).json({ success: true, inventory });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// دالة للحصول على مخزون فرع معين
const getInventoryByBranch = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'بيانات غير صالحة', errors: errors.array() });
  }
  const { branchId } = req.params;
  try {
    const inventory = await Inventory.find({ branch: branchId }).populate('product');
    res.status(200).json({ success: true, inventory });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// دالة لتحديث المخزون (التصحيح الرئيسي هنا: تجاهل branchId واستخدام الحقول المصرح بها فقط)
const updateStock = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'بيانات غير صالحة', errors: errors.array() });
  }

  const { id } = req.params;
  const { currentStock, minStockLevel, maxStockLevel, productId } = req.body; // تجاهل branchId عمداً

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
  }

  try {
    const updateData = { updatedBy: req.user.id };
    if (currentStock !== undefined) updateData.currentStock = currentStock;
    if (minStockLevel !== undefined) updateData.minStockLevel = minStockLevel;
    if (maxStockLevel !== undefined) updateData.maxStockLevel = maxStockLevel;
    if (productId && mongoose.isValidObjectId(productId)) updateData.product = productId;

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      return res.status(404).json({ success: false, message: 'المخزون غير موجود' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const updatedInventory = await Inventory.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });

    // تسجيل التغيير في السجل إذا تم تحديث min أو max
    if (minStockLevel !== undefined || maxStockLevel !== undefined) {
      const history = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        action: 'settings_adjustment',
        quantity: 0, // لا تغيير في الكمية
        reference: 'تعديل مستويات المخزون (min/max)',
        createdBy: req.user.id,
      });
      await history.save();
    }

    res.status(200).json({ success: true, inventory: updatedInventory });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
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
      .populate('product', 'name nameEn price unit unitEn department code')
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
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
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
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود', error: 'errors.no_user' });
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
      .populate('product', 'name nameEn price unit unitEn department code')
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('جلب طلبات إعادة التخزين - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array(), message: 'خطأ في التحقق من البيانات' });
    }

    const { branchId, lang = 'ar' } = req.query;
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
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    const formattedRequests = restockRequests.map(request => ({
      ...request,
      product: request.product
        ? {
            ...request.product,
            name: translateField(request.product, 'name', lang),
            unit: translateField(request.product, 'unit', lang),
            department: request.product.department
              ? {
                  ...request.product.department,
                  name: translateField(request.product.department, 'name', lang),
                }
              : null,
          }
        : null,
      branch: request.branch
        ? {
            ...request.branch,
            name: translateField(request.branch, 'name', lang),
          }
        : null,
    }));

    console.log('جلب طلبات إعادة التخزين - تم بنجاح:', {
      count: formattedRequests.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, restockRequests: formattedRequests });
  } catch (err) {
    console.error('خطأ في جلب طلبات إعادة التخزين:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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

    const history = await InventoryHistory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

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
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
};