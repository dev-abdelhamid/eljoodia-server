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
    });
    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .populate('user', 'username')
      .lean();

    const eventData = {
      ...populatedNotification,
      sound: 'notification.mp3', // Replace with your sound file path
      vibrate: [200, 100, 200], // Vibration pattern
    };

    io.to(`user-${userId}`).emit('notification', eventData);
    io.to('admin').emit('notification', eventData);
    console.log(`[${new Date().toISOString()}] Notification sent to user ${userId}: ${type}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
  }
};

module.exports = { createNotification };