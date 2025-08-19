const mongoose = require('mongoose');
const Notification = require('../models/Notification');

// Create and save a notification
const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    if (!mongoose.isValidObjectId(userId)) {
      console.error(`[${new Date().toISOString()}] Invalid userId for notification: ${userId}`);
      return;
    }

    const notification = new Notification({
      user: userId,
      type,
      message,
      data,
      read: false,
      sound: getSoundForType(type),
      vibrate: getVibratePatternForType(type),
    });
    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .populate('user', 'username')
      .lean();

    const eventData = {
      ...populatedNotification,
      sound: notification.sound,
      vibrate: notification.vibrate,
    };

    io.of('/api').to(`user-${userId}`).emit('newNotification', eventData);
    io.of('/api').to('admin').emit('newNotification', eventData);
    console.log(`[${new Date().toISOString()}] Notification sent to user ${userId}: ${type}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
  }
};

// Helper to determine sound file based on notification type
const getSoundForType = (type) => {
  const sounds = {
    order_created: '/notification.mp3',
    order_status_updated: '/notification.mp3',
    task_assigned: '/notification.mp3',
    task_completed: '/notification.mp3',
    return_created: '/notification.mp3',
    return_status_updated: '/notification.mp3', // Adjust based on status if needed
    order_delivered: '/notification.mp3',
    missing_assignments: '/notification.mp3',
  };
  return sounds[type] || '/notification.mp3';
};

// Helper to determine vibration pattern based on notification type
const getVibratePatternForType = (type) => {
  const patterns = {
    order_created: [300, 100, 300],
    order_status_updated: [200, 100, 200],
    task_assigned: [400, 100, 400],
    task_completed: [200, 100, 200],
    return_created: [300, 100, 300],
    return_status_updated: [200, 100, 200],
    order_delivered: [300, 100, 300],
    missing_assignments: [400, 100, 400],
  };
  return patterns[type] || [200, 100, 200];
};

module.exports = { createNotification };