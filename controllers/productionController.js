const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const validRooms = rooms.filter(room => room && typeof room === 'string');
  if (validRooms.length === 0) {
    console.warn(`[${new Date().toISOString()}] No valid rooms for event ${eventName}:`, { rooms });
    return;
  }
  validRooms.forEach(room => {
    io.of('/api').to(room).emit(eventName, {
      ...eventData,
      sound: eventData.sound || '/public/notification.mp3',
      vibrate: eventData.vibrate || [200, 100, 200],
      timestamp: new Date().toISOString()
    });
    console.log(`[${new Date().toISOString()}] Emitted ${eventName} to room ${room}:`, {
      eventData: { ...eventData, sound: eventData.sound, vibrate: eventData.vibrate }
    });
  });
};

const notifyUsers = async (io, users, type, message, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, { users: users.map(u => u._id), message, data });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err);
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) ||
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين المهام' });
    }

    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id
      });
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending'
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
      sound: '/public/task-assigned.mp3',
      vibrate: [400, 100, 400]
    };
    await emitSocketEvent(io, [`chef-${chef}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch }
    );

    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
    }
    if (task.order._id.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match order ${orderId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}`);

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    order.markModified('items');

    // Check if all items are completed to update order status
    const allItemsCompleted = order.items.every(item => item.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.completedAt = new Date();
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }

    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .lean();

    const taskStatusEvent = {
      taskId,
      orderId,
      itemId: task.itemId,
      status,
      productName: populatedTask.product?.name || 'Unknown',
      orderNumber: populatedTask.order?.orderNumber || 'Unknown',
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      sound: '/public/status-updated.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], 'taskStatusUpdated', taskStatusEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        productName: populatedTask.product?.name || 'Unknown',
        orderNumber: populatedTask.order?.orderNumber || 'Unknown',
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        chef: populatedTask.chef,
        sound: '/public/task-completed.mp3',
        vibrate: [200, 100, 200],
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], 'taskCompleted', taskCompletedEvent);
      await notifyUsers(io, [{ _id: req.user.id }], 'task_completed',
        `تم إكمال المهمة لإنتاج ${populatedTask.product?.name || 'Unknown'} في الطلب ${populatedTask.order?.orderNumber || 'Unknown'}`,
        { taskId, orderId, orderNumber: populatedTask.order?.orderNumber, branchId: order.branch }
      );
    }

    if (allItemsCompleted && order.status === 'completed') {
      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/public/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompleted', orderCompletedEvent);
      await notifyUsers(io, await User.find({ role: { $in: ['admin', 'production', 'branch'] }, branchId: order.branch }).select('_id').lean(),
        'order_completed',
        `تم إكمال الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
    }

    await session.commitTransaction();
    res.status(200).json(populatedTask);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    const order = await Order.findById(orderId)
      .populate('items.product')
      .populate('items.assignedTo')
      .session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found for sync: ${orderId}`);
      return;
    }

    for (const item of order.items) {
      const task = await ProductionAssignment.findOne({ order: orderId, itemId: item._id }).session(session);
      if (!task && item.assignedTo) {
        console.warn(`[${new Date().toISOString()}] Missing task for item ${item._id} in order ${orderId}, assigned to ${item.assignedTo._id}`);
        await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'missingAssignments', {
          orderId,
          itemId: item._id,
          productName: item.product?.name || 'Unknown',
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
          sound: '/public/notification.mp3',
          vibrate: [400, 100, 400],
        });
        continue;
      }
      if (task) {
        if (task.status !== item.status) {
          task.status = item.status;
          if (item.status === 'in_progress' && !task.startedAt) task.startedAt = item.startedAt || new Date();
          if (item.status === 'completed' && !task.completedAt) task.completedAt = item.completedAt || new Date();
          await task.save({ session });
          console.log(`[${new Date().toISOString()}] Synced task ${task._id} status to ${item.status} for item ${item._id}`);
        }
        if (order.status === 'completed' && task.status !== 'completed') {
          task.status = 'completed';
          task.completedAt = task.completedAt || new Date();
          await task.save({ session });
          console.log(`[${new Date().toISOString()}] Updated task ${task._id} to completed due to order ${orderId} completion`);
          await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], 'taskStatusUpdated', {
            taskId: task._id,
            orderId,
            itemId: item._id,
            status: 'completed',
            productName: item.product?.name || 'Unknown',
            orderNumber: order.orderNumber,
            branchId: order.branch,
            branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
            sound: '/public/status-updated.mp3',
            vibrate: [200, 100, 200],
          });
        }
      }
    }

    const allItemsCompleted = order.items.every(item => item.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.completedAt = new Date();
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
      });
      await order.save({ session });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} to completed due to all items completed`);

      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/public/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompleted', orderCompletedEvent);
      await notifyUsers(io, await User.find({ role: { $in: ['admin', 'production', 'branch'] }, branchId: order.branch }).select('_id').lean(),
        'order_completed',
        `تم إكمال الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks for order ${orderId}:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };