const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const { v4: uuidv4 } = require('uuid');

const createNotification = async (userId, type, messageKey, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, messageKey, data });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'new_order_from_branch',
      'order_approved_for_branch',
      'new_production_assigned_to_chef',
      'order_completed_by_chefs',
      'order_in_transit_to_branch',
      'order_delivered',
      'branch_confirmed_receipt',
      'return_status_updated',
      'order_status_updated',
      'task_assigned',
      'missing_assignments',
    ];

    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}`;
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
      message: messageKey,
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
      message: messageKey,
      data: {
        ...notification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        taskId: data.taskId,
        orderId: data.orderId,
        chefId: data.chefId,
      },
      read: notification.read,
      user: {
        _id: populatedNotification.user._id,
        username: populatedNotification.user.username,
        role: populatedNotification.user.role,
        branch: populatedNotification.user.branch || null,
      },
      createdAt: notification.createdAt.toISOString(),
      sound: `${baseUrl}/sounds/notification.mp3`,
      soundType: 'notification',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const rooms = new Set([`user-${userId}`]);
    if (targetUser.role === 'admin') rooms.add('admin');
    if (targetUser.role === 'production') rooms.add('production');
    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.add(`branch-${targetUser.branch._id}`);
    if (targetUser.role === 'chef' && data.chefId) rooms.add(`chef-${data.chefId}`);
    if (data.branchId) rooms.add(`branch-${data.branchId}`);
    if (data.departmentId) rooms.add(`department-${data.departmentId}`);

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

      const branchMessageKey = 'notifications.order_created_success';
      const adminProductionMessageKey = 'notifications.new_order_from_branch';
      const eventId = `${orderId}-new_order_from_branch`;

      const branchEventData = {
        _id: `${orderId}-orderCreated-branch-${Date.now()}`,
        type: 'new_order_from_branch',
        message: branchMessageKey,
        data: { orderId, orderNumber, branchId, branchName: order.branch?.name || 'Unknown', eventId },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const adminProductionEventData = {
        _id: `${orderId}-orderCreated-admin-production-${Date.now()}`,
        type: 'new_order_from_branch',
        message: adminProductionMessageKey,
        data: { orderId, orderNumber, branchId, branchName: order.branch?.name || 'Unknown', eventId },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = branchId ? await User.find({ role: 'branch', branch: branchId }).select('_id').lean() : [];

      // Notify branch users
      for (const user of branchUsers) {
        await createNotification(user._id, 'new_order_from_branch', branchMessageKey, branchEventData.data, io);
      }

      // Notify admin and production users
      for (const user of [...adminUsers, ...productionUsers]) {
        await createNotification(user._id, 'new_order_from_branch', adminProductionMessageKey, adminProductionEventData.data, io);
      }

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => {
        const eventData = room === `branch-${branchId}` ? branchEventData : adminProductionEventData;
        io.to(room).emit('newNotification', eventData);
      });

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
};

module.exports = { createNotification, setupNotifications };