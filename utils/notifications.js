const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data });

    if (!mongoose.isValidObjectId(userId)) {
      console.error(`[${new Date().toISOString()}] Invalid userId for notification: ${userId}`);
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'order_created',
      'order_approved',
      'order_status_updated',
      'task_assigned',
      'task_status_updated',
      'task_completed',
      'order_completed',
      'order_in_transit',
      'order_delivered',
      'return_created',
      'return_status_updated',
      'missing_assignments',
    ];
    if (!validTypes.includes(type)) {
      console.error(`[${new Date().toISOString()}] Invalid notification type: ${type}`);
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    const notification = new Notification({
      user: userId,
      type,
      message,
      data,
      read: false,
      sound: '/notification.mp3',
    });
    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .populate('user', 'username role branch department')
      .lean();

    const eventData = {
      _id: notification._id,
      type: notification.type,
      message: notification.message,
      data: notification.data,
      read: notification.read,
      createdAt: notification.createdAt,
      sound: notification.sound,
      user: populatedNotification.user,
    };

    io.of('/api').to(`user-${userId}`).emit('newNotification', eventData);
    if (populatedNotification.user.role === 'admin') {
      io.of('/api').to('admin').emit('newNotification', eventData);
    }
    console.log(`[${new Date().toISOString()}] Notification sent to user ${userId}:`, { type, message, data });

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
    throw err;
  }
};

module.exports = { createNotification };
