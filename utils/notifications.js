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
      'order_status_updated',
      'task_assigned',
      'task_completed',
      'order_completed',
      'order_delivered',
      'return_created',
      'return_status_updated',
      'missing_assignments'
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
      sound: getSoundForType(type),
      vibrate: getVibratePatternForType(type)
    });
    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .populate('user', 'username')
      .lean();

    const eventData = {
      ...populatedNotification,
      sound: notification.sound,
      vibrate: notification.vibrate
    };

    io.of('/api').to(`user-${userId}`).emit('newNotification', eventData);
    io.of('/api').to('admin').emit('newNotification', eventData);
    console.log(`[${new Date().toISOString()}] Notification sent to user ${userId}:`, { type, message, data });

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
    throw err;
  }
};

const getSoundForType = (type) => {
  const sounds = {
    order_created: '/notification.mp3',
    order_status_updated: '/notification.mp3',
    task_assigned: '/notification.mp3',
    task_completed: '/notification.mp3',
    order_completed: '/notification.mp3',
    order_delivered: '/notification.mp3',
    return_created: '/notification.mp3',
    return_status_updated: '/notification.mp3',
    missing_assignments: '/notification.mp3'
  };
  return sounds[type] || '/notification.mp3';
};

const getVibratePatternForType = (type) => {
  const patterns = {
    order_created: [300, 100, 300],
    order_status_updated: [200, 100, 200],
    task_assigned: [400, 100, 400],
    task_completed: [200, 100, 200],
    order_completed: [300, 100, 300],
    order_delivered: [300, 100, 300],
    return_created: [300, 100, 300],
    return_status_updated: [200, 100, 200],
    missing_assignments: [400, 100, 400]
  };
  return patterns[type] || [200, 100, 200];
};

module.exports = { createNotification };