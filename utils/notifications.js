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

    const targetUser = await User.findById(userId).lean();
    if (!targetUser) {
      console.error(`[${new Date().toISOString()}] User not found for notification: ${userId}`);
      throw new Error('المستخدم غير موجود');
    }

    const notification = new Notification({
      user: userId,
      type,
      message,
      data,
      read: false,
      sound: data.sound || '/notification.mp3', // دعم تخصيص الصوت
      vibrate: data.vibrate || [200, 100, 200], // إضافة خاصية الاهتزاز
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
      sound: notification.sound,
      vibrate: notification.vibrate,
      user: populatedNotification.user,
      createdAt: notification.createdAt,
    };

    const rooms = [`user-${userId}`];
    if (targetUser.role === 'admin') rooms.push('admin');
    if (targetUser.role === 'production') rooms.push('production');
    if (targetUser.role === 'branch' && targetUser.branch) rooms.push(`branch-${targetUser.branch}`);
    if (targetUser.role === 'chef' && targetUser.department) rooms.push(`department-${targetUser.department}`);

    rooms.forEach(room => {
      io.of('/api').to(room).emit('newNotification', eventData);
    });
    console.log(`[${new Date().toISOString()}] Notification sent to rooms: ${rooms.join(', ')}`, eventData);

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
    throw err;
  }
};

module.exports = { createNotification };