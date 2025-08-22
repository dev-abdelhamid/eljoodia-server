const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
};

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  if (!io) {
    console.error(`[${new Date().toISOString()}] Socket.IO not initialized for ${eventName}`);
    throw new Error('Socket.IO not initialized');
  }
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms,
    eventData: { ...eventData, sound: eventData.sound, vibrate: eventData.vibrate }
  });
};

// إنشاء طلب
const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderNumber, items, status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, user: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا', errorCode: 'INVALID_BRANCH_ID' });
    }
    if (!orderNumber || !items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing or invalid orderNumber or items:`, { orderNumber, items });
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة ويجب أن تكون غير فارغة', errorCode: 'INVALID_ORDER_DATA' });
    }

    // التحقق من عدم تكرار المنتجات
    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product)) {
        throw new Error(`معرف المنتج غير صالح: ${item.product}`);
      }
      if (!item.quantity || item.quantity < 1) {
        throw new Error(`الكمية غير صالحة للمنتج: ${item.product}`);
      }
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) existing.quantity += item.quantity;
      else acc.push({ ...item, status: 'pending', startedAt: null, completedAt: null });
      return acc;
    }, []);

    // التحقق من وجود المنتجات
    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).select('price department').session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Some products not found:`, { productIds });
      return res.status(400).json({ success: false, message: 'بعض المنتجات غير موجودة', errorCode: 'PRODUCT_NOT_FOUND' });
    }

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map(item => {
        const product = products.find(p => p._id.toString() === item.product.toString());
        return {
          product: item.product,
          quantity: item.quantity,
          price: item.price || product.price,
          status: 'pending',
        };
      }),
      status,
      notes: notes?.trim(),
      priority,
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => {
        const product = products.find(p => p._id.toString() === item.product.toString());
        return sum + item.quantity * (item.price || product.price);
      }, 0),
      statusHistory: [{ status, changedBy: req.user.id, changedAt: new Date() }],
    });

    await newOrder.save({ session });

    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const notifyRoles = ['production', 'admin'];
    const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_created',
        `طلب جديد ${orderNumber} تم إنشاؤه بواسطة الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
        { orderId: newOrder._id, orderNumber, branchId: branch },
        io
      );
    }

    const orderData = {
      ...populatedOrder,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-created.mp3',
      vibrate: [300, 100, 300],
    };
    await emitSocketEvent(io, [branch.toString(), 'production', 'admin'], 'orderCreated', orderData);

    await session.commitTransaction();
    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Detailed error creating order:`, {
      message: err.message,
      stack: err.stack,
      body: req.body,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
};

// تعيين الشيفات
const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items } = req.body;
    const { id: orderId } = req.params;

    // التحقق من صلاحية orderId والعناصر
    if (!isValidObjectId(orderId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId:`, { orderId });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح', errorCode: 'INVALID_ORDER_ID' });
    }
    if (!items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid or empty items array:`, { items });
      return res.status(400).json({ success: false, message: 'مصفوفة العناصر مطلوبة ويجب أن تكون غير فارغة', errorCode: 'INVALID_ITEMS' });
    }

    // التحقق من صلاحية itemId و assignedTo
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid itemId or assignedTo:`, { itemId: item.itemId, assignedTo: item.assignedTo });
        return res.status(400).json({ success: false, message: `معرف العنصر ${item.itemId} أو معرف الشيف ${item.assignedTo} غير صالح`, errorCode: 'INVALID_ITEM_OR_CHEF' });
      }
    }

    // استرجاع الطلب
    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', select: 'department' })
      .populate('branch', 'name')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found:`, { orderId });
      return res.status(404).json({ success: false, message: 'الطلب غير موجود', errorCode: 'ORDER_NOT_FOUND' });
    }

    // التحقق من حالة الطلب
    if (order.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not approved for task creation:`, { orderId, status: order.status });
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين المهام', errorCode: 'ORDER_NOT_APPROVED' });
    }

    // التحقق من وجود itemId في الطلب
    const orderItemIds = order.items.map(item => item._id.toString());
    for (const item of items) {
      if (!orderItemIds.includes(item.itemId)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Item not found in order:`, { orderId, itemId: item.itemId });
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في الطلب`, errorCode: 'ITEM_NOT_FOUND' });
      }
    }

    // استرجاع الشيفات
    const chefIds = items.map(item => item.assignedTo);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' })
      .populate('department', 'name code')
      .select('username department')
      .session(session);
    if (chefs.length !== chefIds.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Some chefs not found or invalid:`, { chefIds });
      return res.status(400).json({ success: false, message: 'بعض الشيفات غير موجودين أو دورهم غير صالح', errorCode: 'CHEF_NOT_FOUND' });
    }

    // التحقق من تطابق الأقسام
    for (const item of items) {
      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      const chef = chefs.find(c => c._id.toString() === item.assignedTo);
      if (!chef.department || !orderItem.product.department || chef.department._id.toString() !== orderItem.product.department._id.toString()) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Department mismatch:`, {
          itemId: item.itemId,
          chefId: item.assignedTo,
          chefDepartment: chef.department?._id,
          productDepartment: orderItem.product.department?._id
        });
        return res.status(400).json({ success: false, message: `الشيف ${item.assignedTo} غير متطابق مع قسم المنتج`, errorCode: 'DEPARTMENT_MISMATCH' });
      }
    }

    // إنشاء مهام الإنتاج
    const assignments = [];
    for (const item of items) {
      const orderItem = order.items.id(item.itemId);
      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      const assignment = new ProductionAssignment({
        order: orderId,
        item: item.itemId,
        product: orderItem.product,
        chef: item.assignedTo,
        quantity: orderItem.quantity,
        status: 'pending',
        branch: order.branch,
      });
      assignments.push(assignment);
    }

    // حفظ المهام
    await Promise.all(assignments.map(assignment => assignment.save({ session })));
    order.markModified('items');
    await order.save({ session });

    // تحديث المهام
    await syncOrderTasks(orderId, req.app.get('io'), session);

    // استرجاع الطلب بعد التحديث
    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // إرسال الإشعارات
    const io = req.app.get('io');
    const taskAssignedEvent = {
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch._id,
      branchName: order.branch?.name || 'Unknown',
      items: items.map(item => ({
        itemId: item.itemId,
        chefId: item.assignedTo,
      })),
      sound: '/task-assigned.mp3',
      vibrate: [200, 100, 200],
    };
    const uniqueChefIds = [...new Set(items.map(item => item.assignedTo))];
    for (const chefId of uniqueChefIds) {
      await createNotification(
        chefId,
        'task_assigned',
        `تم تعيين مهمة جديدة للطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch._id },
        io
      );
    }
    await emitSocketEvent(io, uniqueChefIds.map(id => `chef-${id}`).concat(['admin', 'production', order.branch._id.toString()]), 'taskAssigned', taskAssignedEvent);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Detailed error in assignChefs:`, {
      orderId,
      items,
      message: err.message,
      stack: err.stack,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
};

// استرجاع الطلبات
const getOrders = async (req, res) => {
  try {
    const { status, branch, page = 1, limit = 20 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Order.countDocuments(query);
    orders.forEach(order => order.items.forEach(item => item.isCompleted = item.status === 'completed'));

    res.status(200).json({ success: true, data: orders, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Detailed error fetching orders:`, {
      message: err.message,
      stack: err.stack,
      query: req.query,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  }
};

// استرجاع طلب معين
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID:`, { id });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح', errorCode: 'INVALID_ORDER_ID' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found:`, { id });
      return res.status(404).json({ success: false, message: 'الطلب غير موجود', errorCode: 'ORDER_NOT_FOUND' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع', errorCode: 'UNAUTHORIZED_BRANCH' });
    }

    order.items.forEach(item => item.isCompleted = item.status === 'completed');
    res.status(200).json({ success: true, data: order });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Detailed error fetching order by id:`, {
      message: err.message,
      stack: err.stack,
      orderId: req.params.id,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  }
};

// اعتماد الطلب
const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID:`, { id });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح', errorCode: 'INVALID_ORDER_ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found:`, { id });
      return res.status(404).json({ success: false, message: 'الطلب غير موجود', errorCode: 'ORDER_NOT_FOUND' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for approval:`, { orderId: id, status: order.status });
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"', errorCode: 'INVALID_ORDER_STATUS' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized approval attempt:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول لاعتماد الطلب', errorCode: 'UNAUTHORIZED' });
    }

    order.status = 'approved';
    order.approvedBy = req.user.id;
    order.approvedAt = new Date();
    order.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin'] }, branchId: order.branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_approved',
        `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
        io
      );
    }

    const orderData = {
      orderId: id,
      status: 'approved',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-approved.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Detailed error approving order:`, {
      message: err.message,
      stack: err.stack,
      orderId: id,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
};

// بدء التوصيل
const startTransit = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID:`, { id });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح', errorCode: 'INVALID_ORDER_ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found:`, { id });
      return res.status(404).json({ success: false, message: 'الطلب غير موجود', errorCode: 'ORDER_NOT_FOUND' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for transit:`, { orderId: id, status: order.status });
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل', errorCode: 'INVALID_ORDER_STATUS' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized transit attempt:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول لبدء التوصيل', errorCode: 'UNAUTHORIZED' });
    }

    order.status = 'in_transit';
    order.transitStartedAt = new Date();
    order.statusHistory.push({
      status: 'in_transit',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_in_transit',
        `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
        io
      );
    }

    const orderData = {
      orderId: id,
      status: 'in_transit',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-in-transit.mp3',
      vibrate: [300, 100, 300],
    };
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderInTransit', {
      ...orderData,
      transitStartedAt: new Date().toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Detailed error starting transit:`, {
      message: err.message,
      stack: err.stack,
      orderId: req.params.id,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
};

// تحديث حالة الطلب
const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID:`, { id });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح', errorCode: 'INVALID_ORDER_ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found:`, { id });
      return res.status(404).json({ success: false, message: 'الطلب غير موجود', errorCode: 'ORDER_NOT_FOUND' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status transition:`, { orderId: id, current: order.status, new: status });
      return res.status(400).json({ success: false, message: `الانتقال من ${order.status} إلى ${status} غير مسموح`, errorCode: 'INVALID_STATUS_TRANSITION' });
    }

    order.status = status;
    if (notes) order.notes = notes.trim();
    order.statusHistory.push({ status, changedBy: req.user.id, notes, changedAt: new Date() });
    await order.save({ session });

    await syncOrderTasks(id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const notifyRoles = {
      approved: ['production'],
      in_production: ['chef', 'branch'],
      in_transit: ['branch', 'admin'],
      cancelled: ['branch', 'production', 'admin'],
      delivered: ['branch', 'admin'],
      completed: ['branch', 'admin'],
    }[status] || [];

    const io = req.app.get('io');
    if (notifyRoles.length) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch }).select('_id').lean();
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
          { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
          io
        );
      }
    }

    const orderData = {
      orderId: id,
      status,
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/status-updated.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);

    if (status === 'completed') {
      const completedEventData = {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderCompleted', completedEventData);
    }

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Detailed error updating order status:`, {
      message: err.message,
      stack: err.stack,
      orderId: req.params.id,
      body: req.body,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
};

// تأكيد التسليم
const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID:`, { id });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح', errorCode: 'INVALID_ORDER_ID' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch').session(session);
    if (!order || order.status !== 'in_transit') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for delivery:`, { status: order?.status, orderId: id });
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل', errorCode: 'INVALID_ORDER_STATUS' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع', errorCode: 'UNAUTHORIZED_BRANCH' });
    }

    // التحقق من عدم وجود كميات سالبة في المخزون
    for (const item of order.items) {
      const inventory = await Inventory.findOne({ branch: order.branch, product: item.product }).session(session);
      const newStock = (inventory?.currentStock || 0) + (item.quantity - (item.returnedQuantity || 0));
      if (newStock < 0) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Insufficient stock for delivery:`, { product: item.product, branch: order.branch, newStock });
        return res.status(400).json({ success: false, message: `المخزون غير كافٍ للمنتج ${item.product.name}`, errorCode: 'INSUFFICIENT_STOCK' });
      }
      await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        { $inc: { currentStock: item.quantity - (item.returnedQuantity || 0) } },
        { upsert: true, session }
      );
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({ status: 'delivered', changedBy: req.user.id });
    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] }, branchId: order.branch?._id }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_delivered',
        `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${order.branch?.name || 'Unknown'}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch?._id },
        io
      );
    }

    const orderData = {
      orderId: id,
      status: 'delivered',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
      deliveredAt: new Date().toISOString(),
      sound: '/order-delivered.mp3',
      vibrate: [300, 100, 300],
    };
    await emitSocketEvent(io, [order.branch?._id.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);
    await emitSocketEvent(io, [order.branch?._id.toString(), 'production', 'admin'], 'orderDelivered', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Detailed error confirming delivery:`, {
      message: err.message,
      stack: err.stack,
      orderId: req.params.id,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
};

// الموافقة على الإرجاع
const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return ID:`, { id });
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح', errorCode: 'INVALID_RETURN_ID' });
    }

    const returnRequest = await Return.findById(id).populate('order').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Return not found:`, { id });
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود', errorCode: 'RETURN_NOT_FOUND' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return status:`, { status });
      return res.status(400).json({ success: false, message: 'حالة غير صالحة', errorCode: 'INVALID_RETURN_STATUS' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized return approval:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع', errorCode: 'UNAUTHORIZED' });
    }

    if (status === 'approved') {
      const order = await Order.findById(returnRequest.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order not found for return:`, { orderId: returnRequest.order._id });
        return res.status(404).json({ success: false, message: 'الطلب غير موجود', errorCode: 'ORDER_NOT_FOUND' });
      }

      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Order item not found for return:`, { itemId: returnItem.itemId });
          return res.status(400).json({ success: false, message: `العنصر ${returnItem.itemId} غير موجود في الطلب`, errorCode: 'ITEM_NOT_FOUND' });
        }
        if ((orderItem.returnedQuantity || 0) + returnItem.quantity > orderItem.quantity) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { itemId: returnItem.itemId, requested: returnItem.quantity, available: orderItem.quantity });
          return res.status(400).json({ success: false, message: `كمية الإرجاع غير صالحة للعنصر ${returnItem.itemId}`, errorCode: 'INVALID_RETURN_QUANTITY' });
        }
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: returnItem.product },
          { $inc: { currentStock: -returnItem.quantity } },
          { upsert: true, session }
        );
      }
      order.markModified('items');
      await order.save({ session });
    }

    returnRequest.status = status;
    if (reviewNotes) returnRequest.reviewNotes = reviewNotes.trim();
    await returnRequest.save({ session });

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order?.branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order?.orderNumber || 'Unknown'}`,
        { returnId: id, orderId: returnRequest.order?._id, orderNumber: returnRequest.order?.orderNumber },
        io
      );
    }

    const returnData = {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
      sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [returnRequest.order?.branch.toString(), 'admin', 'production'], 'returnStatusUpdated', returnData);

    await session.commitTransaction();
    res.status(200).json(returnRequest);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Detailed error approving return:`, {
      message: err.message,
      stack: err.stack,
      returnId: req.params.id,
      body: req.body,
      user: req.user
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message, errorCode: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
};

module.exports = { createOrder, assignChefs, getOrders, getOrderById, approveOrder, startTransit, updateOrderStatus, confirmDelivery, approveReturn };