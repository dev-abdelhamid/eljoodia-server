const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const ProductionAssignment = require('../models/ProductionAssignment');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = new Set(rooms);
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
    eventData: eventDataWithSound,
  });
};

const notifyUsers = async (io, users, type, message, data, saveToDb = false) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId)
      .populate('items.product')
      .session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found for syncOrderTasks: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    const taskMap = new Map(tasks.map(t => [t.itemId.toString(), t]));

    const assignments = [];
    for (const item of order.items) {
      if (!taskMap.has(item._id.toString()) && item.assignedTo) {
        assignments.push(
          new ProductionAssignment({
            order: orderId,
            itemId: item._id,
            product: item.product._id,
            chef: item.assignedTo,
            quantity: item.quantity,
            status: 'pending',
          }).save({ session })
        );
      }
    }

    await Promise.all(assignments);
    console.log(`[${new Date().toISOString()}] Synced tasks for order ${orderId}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, {
      error: err.message,
      orderId,
      stack: err.stack,
    });
    throw err;
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;

    if (!isValidObjectId(order) || !isValidObjectId(product) || !isValidObjectId(chef) || !isValidObjectId(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، أو العنصر غير صالح' });
    }

    if (quantity < 1) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكمية يجب أن تكون أكبر من 0' });
    }

    const orderDoc = await Order.findById(order).populate('items.product').session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const item = orderDoc.items.find(i => i._id.toString() === itemId);
    if (!item) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'العنصر غير موجود في الطلب' });
    }

    const user = await User.findOne({ _id: chef, role: 'chef' }).lean();
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الشيف غير موجود' });
    }

    const task = new ProductionAssignment({
      order,
      itemId,
      product,
      chef,
      quantity,
      status: 'pending',
    });

    await task.save({ session });

    item.assignedTo = chef;
    item.status = 'assigned';
    orderDoc.markModified('items');
    await orderDoc.save({ session });

    const populatedTask = await ProductionAssignment.findById(task._id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate('chef', 'name') // تغيير إلى name
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: orderDoc.branch },
        { _id: chef },
      ],
    }).select('_id role').lean();

    const eventId = `${task._id}-task_created`;
    const eventData = {
      taskId: task._id,
      orderId: order,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      productId: product,
      productName: populatedTask.product?.name || 'غير معروف',
      quantity,
      chefId: chef,
      chefName: populatedTask.chef?.name || 'غير معروف',
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    await notifyUsers(
      io,
      usersToNotify,
      'taskCreated',
      `تم إنشاء مهمة جديدة للشيف ${populatedTask.chef?.name || 'غير معروف'} في الطلب ${orderDoc.orderNumber}`,
      eventData,
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${orderDoc.branch}`, `chef-${chef}`], 'taskCreated', eventData);

    await session.commitTransaction();
    res.status(201).json(populatedTask);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const { status, order, chef, page = 1, limit = 10 } = req.query;
    const query = {};

    if (status) query.status = status;
    if (order && isValidObjectId(order)) query.order = order;
    if (chef && isValidObjectId(chef)) query.chef = chef;

    console.log(`[${new Date().toISOString()}] Fetching tasks with query:`, { query, userId: req.user.id });

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate('chef', 'name') // تغيير إلى name
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const total = await ProductionAssignment.countDocuments(query);

    console.log(`[${new Date().toISOString()}] Found ${tasks.length} tasks`);

    res.status(200).json({
      tasks,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    const { status, page = 1, limit = 10, search } = req.query;

    if (!isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chef ID: ${chefId}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    if (req.user.role === 'chef' && chefId !== req.user.id) {
      console.error(`[${new Date().toISOString()}] Unauthorized chef access:`, {
        chefId,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لعرض مهام شيف آخر' });
    }

    const query = { chef: chefId };
    if (status) query.status = status;
    if (search) query['order.orderNumber'] = { $regex: search, $options: 'i' };

    console.log(`[${new Date().toISOString()}] Fetching chef tasks with query:`, { query, userId: req.user.id });

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate('chef', 'name') // تغيير إلى name
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const total = await ProductionAssignment.countDocuments(query);

    console.log(`[${new Date().toISOString()}] Found ${tasks.length} tasks for chef ${chefId}`);

    res.status(200).json({
      tasks,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, taskId } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    if (!status || !['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحالة غير صالحة' });
    }

    const task = await ProductionAssignment.findById(taskId).session(session);
    if (!task) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }

    if (task.order.toString() !== orderId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    if (req.user.role === 'chef' && task.chef.toString() !== req.user.id) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة هذه المهمة' });
    }

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const item = order.items.find(i => i._id.toString() === task.itemId.toString());
    if (!item) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'العنصر غير موجود في الطلب' });
    }

    task.status = status;
    item.status = status === 'completed' ? 'completed' : status;
    if (status === 'in_progress') item.startedAt = new Date();
    if (status === 'completed') item.completedAt = new Date();

    order.markModified('items');
    await task.save({ session });
    await order.save({ session });

    const allItemsCompleted = order.items.every(i => i.status === 'completed');
    if (allItemsCompleted && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: 'جميع العناصر مكتملة',
      });
      await order.save({ session });
    }

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate('chef', 'name') // تغيير إلى name
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
        { _id: task.chef },
      ],
    }).select('_id role').lean();

    const eventId = `${taskId}-task_status_updated`;
    const eventData = {
      taskId,
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      productId: task.product,
      productName: populatedTask.product?.name || 'غير معروف',
      quantity: task.quantity,
      chefId: task.chef,
      chefName: populatedTask.chef?.name || 'غير معروف',
      status,
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    await notifyUsers(
      io,
      usersToNotify,
      'taskStatusUpdated',
      `تم تحديث حالة المهمة للمنتج ${populatedTask.product?.name || 'غير معروف'} في الطلب ${order.orderNumber} إلى ${status}`,
      eventData,
      status === 'completed'
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`, `chef-${task.chef}`], 'taskStatusUpdated', eventData);

    await session.commitTransaction();
    res.status(200).json(populatedTask);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
  syncOrderTasks,
};