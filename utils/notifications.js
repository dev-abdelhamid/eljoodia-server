const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');

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

    if (!io || typeof io.of !== 'function') {
      console.error(`[${new Date().toISOString()}] Invalid Socket.IO instance`);
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate([
        { path: 'branch', select: 'name' },
        { path: 'department', select: 'name', options: { strictPopulate: false } }
      ])
      .lean();
    
    if (!targetUser) {
      console.error(`[${new Date().toISOString()}] User not found for notification: ${userId}`);
      throw new Error('المستخدم غير موجود');
    }

    const soundUrl = `https://eljoodia-server-production.up.railway.app/sounds/${type}.mp3`;
    const notification = new Notification({
      user: userId,
      type,
      message: message.trim(),
      data,
      read: false,
      sound: soundUrl,
      vibrate: [200, 100, 200],
      createdAt: new Date(),
      department: targetUser.department?._id || null,
    });

    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .select('user type message data read createdAt department')
      .populate([
        { path: 'user', select: 'username role branch department' },
        { path: 'department', select: 'name', options: { strictPopulate: false } }
      ])
      .lean();

    const eventData = {
      _id: notification._id,
      type: notification.type,
      message: notification.message,
      data: notification.data,
      read: notification.read,
      sound: notification.sound,
      vibrate: notification.vibrate,
      user: {
        _id: populatedNotification.user._id,
        username: populatedNotification.user.username,
        role: populatedNotification.user.role,
        branch: populatedNotification.user.branch || null,
        department: populatedNotification.user.department || null,
      },
      department: populatedNotification.department || null,
      createdAt: notification.createdAt,
    };

    const rooms = [`user-${userId}`];
    if (targetUser.role === 'admin') rooms.push('admin');
    if (targetUser.role === 'production') rooms.push('production');
    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.push(`branch-${targetUser.branch._id}`);
    if (targetUser.role === 'chef' && targetUser.department?._id) rooms.push(`department-${targetUser.department._id}`);

    rooms.forEach(room => {
      io.of('/api').to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
    });

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, {
      message: err.message,
      stack: err.stack,
      userId,
      type,
      data
    });
    throw err;
  }
};

module.exports = { createNotification };