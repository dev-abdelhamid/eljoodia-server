const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = ['orderCreated', 'orderCompleted'];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = `${data.orderId || 'generic'}-${type}-${userId}`;
    const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
    if (existingNotification) {
      console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
      return existingNotification;
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .lean();

    if (!targetUser) {
      throw new Error('المستخدم غير موجود');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    const notification = new Notification({
      _id: uuidv4(),
      user: userId,
      type,
      message: message.trim(),
      data: { ...data, eventId },
      read: false,
      createdAt: new Date(),
    });

    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .populate('user', 'username role branch')
      .lean();

    const eventData = {
      _id: notification._id,
      type: notification.type,
      message: notification.message,
      data: {
        ...notification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        orderId: data.orderId,
      },
      read: notification.read,
      user: {
        _id: populatedNotification.user._id,
        username: populatedNotification.user.username,
        role: populatedNotification.user.role,
        branch: populatedNotification.user.branch || null,
      },
      createdAt: notification.createdAt,
      sound: `${baseUrl}/sounds/notification.mp3`,
      soundType: 'notification',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && targetUser.branch?._id) rooms.add(`branch-${targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);
    if (data.branchId) rooms.add(`branch-${data.branchId}`);

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
    });

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, {
      message: err.message,
      stack: err.stack,
      userId,
      type,
      data,
    });
    throw err;
  }
};

const setupNotifications = (io, socket) => {
  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `طلب جديد ${orderNumber} من ${order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'orderCreated',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderCreated` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderCreated', message, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskAssigned = async (data) => {
    const { orderId, taskId, chefId, productId, productName, quantity, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `تم تعيين مهمة جديدة لك: ${productName || 'Unknown'} في الطلب ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskAssigned-${Date.now()}`,
        type: 'taskAssigned',
        message,
        data: { orderId, taskId, branchId: order.branch?._id || branchId, chefId, productId, productName, quantity, eventId: `${taskId}-taskAssigned` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskStarted = async (data) => {
    const { orderId, taskId, chefId, productName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `بدأ الشيف العمل على (${productName || 'Unknown'}) في الطلب ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskStarted-${Date.now()}`,
        type: 'taskStarted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-taskStarted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task started:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskCompleted = async (data) => {
    const { orderId, taskId, chefId, productName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session);
      if (!order) return;

      const message = `تم إكمال مهمة (${productName || 'Unknown'}) في الطلب ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskCompleted-${Date.now()}`,
        type: 'taskCompleted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-taskCompleted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const allTasksCompleted = await ProductionAssignment.find({ order: orderId }).session(session).lean();
      const isOrderCompleted = allTasksCompleted.every(task => task.status === 'completed');

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      if (isOrderCompleted) {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
        });
        await order.save({ session });

        const completionMessage = `تم إكمال الطلب ${order.orderNumber} بالكامل`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: completionMessage,
          data: { orderId, branchId: order.branch?._id, eventId: `${orderId}-orderCompleted` },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          soundType: 'notification',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const completionRooms = new Set(['admin', 'production', `branch-${order.branch?._id}`, `chef-${chefId}`]);
        completionRooms.forEach(room => io.to(room).emit('newNotification', completionEventData));

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        const branchUsers = await User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean();
        const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers]) {
          await createNotification(user._id, 'orderCompleted', completionMessage, completionEventData.data, io);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('taskStarted', handleTaskStarted);
  socket.on('taskCompleted', handleTaskCompleted);
};

module.exports = { createNotification, setupNotifications };