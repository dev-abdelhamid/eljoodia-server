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

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;

    if (!isValidObjectId(branchId)) {
      console.log('جلب مخزون الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب مخزون الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لجلب مخزون هذا الفرع' });
    }

    const inventory = await Inventory.find({ branch: branchId })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .lean();

    console.log('جلب مخزون الفرع - تم بنجاح:', { branchId, itemsCount: inventory.length });
    res.status(200).json({ success: true, inventory });
  } catch (err) {
    console.error('خطأ في جلب مخزون الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const { branchId } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log('جلب سجل المخزون - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب سجل المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لجلب سجل مخزون هذا الفرع' });
    }

    const history = await InventoryHistory.find({ branch: branchId })
      .populate('product', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    console.log('جلب سجل المخزون - تم بنجاح:', { branchId, historyCount: history.length });
    res.status(200).json({ success: true, history });
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get all returns
const getAllReturns = async (req, res) => {
  try {
    const { branch } = req.query;

    if (!isValidObjectId(branch)) {
      console.log('جلب المرتجعات - معرف الفرع غير صالح:', { branch });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branch !== req.user.branchId?.toString()) {
      console.log('جلب المرتجعات - غير مخول:', { userId: req.user.id, branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لجلب مرتجعات هذا الفرع' });
    }

    const returns = await Return.find({ branch })
      .populate('order', 'orderNumber')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    console.log('جلب المرتجعات - تم بنجاح:', { branch, returnsCount: returns.length });
    res.status(200).json({ success: true, returns });
  } catch (err) {
    console.error('خطأ في جلب المرتجعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  createInventory,
  updateStockLevels,
  createReturn,
  processReturnItems,
  getInventoryByBranch,
  getInventoryHistory,
  getAllReturns,
};