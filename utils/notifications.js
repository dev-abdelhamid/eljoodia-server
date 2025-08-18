const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const createNotification = async (to, type, message, data, io) => {
  try {
    if (!mongoose.isValidObjectId(to)) {
      console.error(`[${new Date().toISOString()}] Invalid user ID for notification:`, to);
      throw new Error('Invalid user ID');
    }
    const notification = new Notification({
      user: to,
      type,
      message,
      data,
      read: false,
    });
    await notification.save();
    io.to(`user-${to}`).emit('newNotification', {
      _id: notification._id,
      user: to,
      type,
      message,
      data,
      read: false,
      createdAt: notification.createdAt,
    });
    console.log(`[${new Date().toISOString()}] Notification sent to user-${to}:`, { type, message });
    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
    throw err;
  }
};

module.exports = { createNotification };
