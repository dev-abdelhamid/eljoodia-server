const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach((room) => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms,
    eventData: { ...eventData, sound: eventData.sound, vibrate: eventData.vibrate },
  });
};

const notifyUsers = async (io, users, type, message, data) => {
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err);
    }
  }
};

// Create a new production task
const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!isValidObjectId(order) || !isValidObjectId(product) || !isValidObjectId(chef) || !quantity || quantity < 1 || !isValidObjectId(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderDoc.status !== 'approved' && orderDoc.status !== 'in_production') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج"' });
    }

    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (
      !chefDoc ||
      chefDoc.role !== 'chef' ||
      !chefProfile ||
      chefDoc.department?._id.toString() !== productDoc.department?._id.toString()
    ) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
    }

    const existingTask = await ProductionAssignment.findOne({ order, itemId }).session(session);
    if (existingTask) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة موجودة بالفعل لهذا العنصر' });
    }

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending',
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    orderDoc.markModified('items');
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
      sound: '/task-assigned.mp3',
      vibrate: [400, 100, 400],
    };
    await emitSocketEvent(io, [`chef-${chefProfile._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch }
    );

    await session.commitTransaction();
    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all production tasks
const getTasks = async (req, res) => {
  try {
    const { status, branch, department } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (department && isValidObjectId(department)) query['product.department'] = department;

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get tasks for a specific chef
const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update task status
const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (!task.itemId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
    }
    if (task.order._id.toString() !== orderId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (task.status === 'completed' && status === 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = task.startedAt || new Date();
    if (status === 'completed') task.completedAt = task.completedAt || new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = orderItem.startedAt || new Date();
    if (status === 'completed') orderItem.completedAt = orderItem.completedAt || new Date();
    order.markModified('items');

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_status_updated',
        `بدأ إنتاج الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        sound: '/notification.mp3',
        vibrate: [200, 100, 200],
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', orderStatusUpdatedEvent);
    }

    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      itemId: task.itemId,
      productName: populatedTask.product?.name || 'Unknown',
      sound: '/status-updated.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
        productName: populatedTask.product?.name || 'Unknown',
        sound: '/task-completed.mp3',
        vibrate: [200, 100, 200],
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskCompleted', taskCompletedEvent);
      await notifyUsers(io, [{ _id: task.chef._id }], 'task_completed',
        `تم إكمال مهمة للطلب ${task.order.orderNumber}`,
        { taskId, orderId, orderNumber: task.order.orderNumber, branchId: order.branch }
      );
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Sync order tasks with production assignments
const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      console.warn(`[${new Date().toISOString()}] Order not found for sync: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    const taskItemIds = tasks.map((t) => t.itemId?.toString()).filter(Boolean);
    const missingItems = order.items.filter((item) => !taskItemIds.includes(item._id?.toString()) && item._id);

    if (missingItems.length > 0) {
      for (const item of missingItems) {
        if (!item._id) continue;
        const product = await Product.findById(item.product).lean();
        if (!product) continue;
        await emitSocketEvent(io, ['production', 'admin', `branch-${order.branch}`], 'missingAssignments', {
          orderId,
          itemId: item._id,
          productId: product._id,
          productName: product.name,
          sound: '/notification.mp3',
          vibrate: [400, 100, 400],
        });
      }
    }

    let hasIncompleteItems = false;
    for (const task of tasks) {
      const orderItem = order.items.id(task.itemId);
      if (orderItem) {
        orderItem.status = task.status;
        if (task.status === 'in_progress') orderItem.startedAt = task.startedAt || new Date();
        if (task.status === 'completed') orderItem.completedAt = task.completedAt || new Date();
        if (task.status !== 'completed') hasIncompleteItems = true;
      }
    }

    for (const item of order.items) {
      if (!taskItemIds.includes(item._id.toString()) && item.status !== 'completed') {
        hasIncompleteItems = true;
      }
    }

    const allTasksCompleted = tasks.every((t) => t.status === 'completed');
    const allOrderItemsCompleted = order.items.every((i) => i.status === 'completed');

    if (
      allTasksCompleted &&
      allOrderItemsCompleted &&
      !['completed', 'in_transit', 'delivered'].includes(order.status)
    ) {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date(),
      });
      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم اكتمال الطلب ${order.orderNumber} لفرع ${branch?.name || 'Unknown'}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName: branch?.name || 'Unknown' }
      );
      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', orderCompletedEvent);
    }

    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in syncOrderTasks for order ${orderId}:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };