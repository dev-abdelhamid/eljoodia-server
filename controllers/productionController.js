const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const { createNotification } = require('../utils/notifications');

// Cache for users to improve performance
const usersCache = new Map();

const getUsers = async (roles, branchId = null) => {
  const cacheKey = `${roles.join('-')}-${branchId || 'all'}`;
  if (usersCache.has(cacheKey)) return usersCache.get(cacheKey);
  const query = { role: { $in: roles } };
  if (branchId) query.branch = branchId;
  const users = await User.find(query).select('_id username branch').lean();
  usersCache.set(cacheKey, users);
  return users;
};

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const soundTypeMap = {
    taskAssigned: 'task_assigned',
    taskStatusUpdated: 'task_status_updated',
    taskCompleted: 'task_completed',
    orderStatusUpdated: 'order_status_updated',
  };
  const soundType = soundTypeMap[eventName] || 'notification';
  const eventDataWithSound = {
    ...eventData,
    sound: `https://eljoodia-client.vercel.app/sounds/${soundType}.mp3`,
    vibrate: eventName === 'taskAssigned' ? [400, 100, 400] : [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${eventData.taskId || eventData.orderId || Date.now()}`,
  };
  const uniqueRooms = [...new Set(rooms.filter(room => !room.includes('department-') && room !== 'all-departments'))];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName} to rooms: ${uniqueRooms.join(', ')}`, {
    eventData: eventDataWithSound,
  });
};

const notifyUsers = async (io, users, type, message, data) => {
  for (const user of users) {
    try {
      const notification = await createNotification(
        user._id,
        type,
        message,
        { ...data, eventId: `${data.taskId || data.orderId || 'generic'}-${type}-${user._id}-${Date.now()}` },
        io
      );
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input data:`, { order, product, chef, quantity, itemId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'بيانات الإدخال غير صالحة' });
    }

    const [orderDoc, productDoc, chefDoc] = await Promise.all([
      Order.findById(order).session(session),
      Product.findById(product).select('name price unit department').populate('department', 'name code').lean(),
      User.findOne({ _id: chef, role: 'chef' }).select('username branch').lean(),
    ]);

    if (!orderDoc || !productDoc || !chefDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order, product, or chef:`, { order, product, chef, userId: req.user.id });
      return res.status(404).json({ success: false, message: 'الطلب أو المنتج أو الشيف غير موجود' });
    }

    if (req.user.role === 'branch' && orderDoc.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: orderDoc.branch, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const orderItem = orderDoc.items.find(item => item._id.toString() === itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'العنصر غير موجود أو لا يتطابق مع المنتج' });
    }

    if (orderItem.status !== 'pending' && orderItem.status !== 'assigned') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid item status for task creation: ${orderItem.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'حالة العنصر غير صالحة لإنشاء المهمة' });
    }

    const existingAssignment = await ProductionAssignment.findOne({ order, itemId }).session(session);
    if (existingAssignment && existingAssignment.chef.toString() !== chef) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Task already assigned to another chef:`, { itemId, existingChef: existingAssignment.chef, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'المهمة معينة بالفعل لشيف آخر' });
    }

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderDoc.status = orderDoc.items.every(item => item.status === 'assigned' || item.status === 'completed') ? 'in_production' : orderDoc.status;
    orderDoc.markModified('items');
    await orderDoc.save({ session });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
      itemId,
      status: 'pending',
      createdBy: req.user.id,
    });
    await newAssignment.save({ session });

    const populatedTask = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name price unit department')
      .populate('chef', 'username')
      .session(session)
      .lean();

    const taskAssignedEvent = {
      _id: newAssignment._id,
      type: 'task_assigned',
      orderId: order,
      taskId: newAssignment._id,
      chefId: chef,
      chefName: chefDoc.username,
      productId: product,
      productName: productDoc.name,
      quantity,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
      eventId: `${newAssignment._id}-task_assigned`,
    };

    await emitSocketEvent(io, [
      `chef-${chef}`,
      `branch-${orderDoc.branch}`,
      'admin',
      'production',
    ], 'taskAssigned', taskAssignedEvent);

    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { orderId: order, taskId: newAssignment._id, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch, chefId: chef, productId: product, productName: productDoc.name, quantity }
    );

    await session.commitTransaction();
    res.status(201).json({
      ...populatedTask,
      branchId: orderDoc.branch,
      branchName: taskAssignedEvent.branchName,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const { orderId, chefId, status } = req.query;
    const query = {};
    if (orderId && mongoose.isValidObjectId(orderId)) query.order = orderId;
    if (chefId && mongoose.isValidObjectId(chefId)) query.chef = chefId;
    if (status) query.status = status;

    if (req.user.role === 'branch' && req.user.branchId) {
      const orders = await Order.find({ branch: req.user.branchId }).select('_id').lean();
      query.order = { $in: orders.map(o => o._id) };
    }

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name price unit department')
      .populate('chef', 'username')
      .lean();

    console.log(`[${new Date().toISOString()}] Found ${tasks.length} tasks for query:`, { query, userId: req.user.id });

    const formattedTasks = await Promise.all(tasks.map(async task => ({
      ...task,
      branchId: task.order?.branch,
      branchName: (task.order?.branch && (await mongoose.model('Branch').findById(task.order.branch).select('name').lean())?.name) || 'Unknown',
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
    })));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chef ID: ${chefId}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    if (req.user.role === 'chef' && req.user.id !== chefId) {
      console.error(`[${new Date().toISOString()}] Unauthorized chef access:`, { requestedChef: chefId, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'غير مخول لعرض مهام هذا الشيف' });
    }

    const query = { chef: chefId };
    if (req.user.role === 'branch' && req.user.branchId) {
      const orders = await Order.find({ branch: req.user.branchId }).select('_id').lean();
      query.order = { $in: orders.map(o => o._id) };
    }

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name price unit department')
      .populate('chef', 'username')
      .lean();

    console.log(`[${new Date().toISOString()}] Found ${tasks.length} tasks for chef ${chefId}`);

    const formattedTasks = await Promise.all(tasks.map(async task => ({
      ...task,
      branchId: task.order?.branch,
      branchName: (task.order?.branch && (await mongoose.model('Branch').findById(task.order.branch).select('name').lean())?.name) || 'Unknown',
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
    })));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found for sync: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    const taskMap = new Map(tasks.map(t => [t.itemId.toString(), t]));

    for (const item of order.items) {
      const task = taskMap.get(item._id.toString());
      if (task && item.status !== task.status) {
        item.status = task.status;
        item.startedAt = task.startedAt;
        item.completedAt = task.completedAt;
        item.assignedTo = task.chef;
      } else if (!task && item.status !== 'pending') {
        item.status = 'pending';
        item.startedAt = null;
        item.completedAt = null;
        item.assignedTo = null;
      }
    }

    order.status = order.items.every(item => item.status === 'completed') ? 'completed' :
                   order.items.every(item => item.status === 'pending') ? 'approved' :
                   order.items.some(item => item.status === 'assigned' || item.status === 'in_progress') ? 'in_production' :
                   order.status;

    order.markModified('items');
    await order.save({ session });

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const orderData = {
      ...populatedOrder,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${orderId}-order_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', orderData);
    console.log(`[${new Date().toISOString()}] Synced tasks for order ${orderId}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, { error: err.message, orderId });
    throw err;
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { taskId } = req.params;
    const { status } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(taskId) || !['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid task ID or status:`, { taskId, status, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف المهمة أو الحالة غير صالحة' });
    }

    const task = await ProductionAssignment.findById(taskId).session(session);
    if (!task) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }

    if (req.user.role === 'chef' && task.chef.toString() !== req.user.id) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized task status update:`, { taskId, userId: req.user.id, chefId: task.chef });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة هذه المهمة' });
    }

    task.status = status;
    if (status === 'in_progress' && !task.startedAt) task.startedAt = new Date();
    if (status === 'completed' && !task.completedAt) task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(task.order).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for task: ${task.order}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const orderItem = order.items.find(item => item._id.toString() === task.itemId.toString());
    if (!orderItem) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order item not found for task: ${task.itemId}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'العنصر غير موجود في الطلب' });
    }

    orderItem.status = status;
    orderItem.startedAt = task.startedAt;
    orderItem.completedAt = task.completedAt;
    order.markModified('items');

    order.status = order.items.every(item => item.status === 'completed') ? 'completed' :
                   order.items.every(item => item.status === 'pending') ? 'approved' :
                   order.items.some(item => item.status === 'assigned' || item.status === 'in_progress') ? 'in_production' :
                   order.status;

    await order.save({ session });

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name price unit department')
      .populate('chef', 'username')
      .session(session)
      .lean();

    const taskData = {
      taskId,
      orderId: task.order,
      orderNumber: populatedTask.order?.orderNumber,
      productId: task.product,
      productName: populatedTask.product?.name,
      chefId: task.chef,
      chefName: populatedTask.chef?.username,
      quantity: task.quantity,
      status,
      itemId: task.itemId,
      branchId: populatedTask.order?.branch,
      branchName: (await mongoose.model('Branch').findById(populatedTask.order?.branch).select('name').lean())?.name || 'Unknown',
      eventId: `${taskId}-task_status_updated`,
    };

    await emitSocketEvent(io, [
      `chef-${task.chef}`,
      `branch-${populatedTask.order?.branch}`,
      'admin',
      'production',
    ], 'taskStatusUpdated', taskData);

    if (status === 'completed') {
      await notifyUsers(io, [{ _id: task.chef }], 'task_completed',
        `تم إكمال إنتاج ${populatedTask.product?.name} في الطلب ${populatedTask.order?.orderNumber}`,
        { orderId: task.order, taskId, orderNumber: populatedTask.order?.orderNumber, branchId: populatedTask.order?.branch, chefId: task.chef, productId: task.product, productName: populatedTask.product?.name, quantity: task.quantity }
      );

      const populatedOrder = await Order.findById(task.order)
        .populate('branch', 'name')
        .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
        .populate('items.assignedTo', 'username')
        .populate('createdBy', 'username')
        .populate('returns')
        .session(session)
        .lean();

      if (order.status === 'completed') {
        const orderData = {
          orderId: task.order,
          orderNumber: populatedOrder.orderNumber,
          status: 'completed',
          branchId: populatedOrder.branch?._id,
          branchName: populatedOrder.branch?.name || 'Unknown',
          adjustedTotal: populatedOrder.adjustedTotal,
          createdAt: new Date(populatedOrder.createdAt).toISOString(),
          eventId: `${task.order}-order_completed`,
        };

        await emitSocketEvent(io, ['admin', 'production', `branch-${populatedOrder.branch?._id}`], 'taskCompleted', orderData);

        const usersToNotify = await getUsers(['admin', 'production', 'branch'], populatedOrder.branch?._id);
        await notifyUsers(io, usersToNotify, 'task_completed',
          `تم إكمال الطلب ${populatedOrder.orderNumber} بالكامل`,
          { orderId: task.order, orderNumber: populatedOrder.orderNumber, branchId: populatedOrder.branch?._id }
        );
      }
    }

    await session.commitTransaction();
    res.status(200).json({
      ...populatedTask,
      branchId: populatedTask.order?.branch,
      branchName: taskData.branchName,
      status,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };