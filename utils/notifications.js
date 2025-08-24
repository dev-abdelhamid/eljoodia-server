const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data });

    // التحقق من صحة معرف المستخدم
    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    // جلب بيانات المستخدم
    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();
    if (!targetUser) {
      throw new Error('المستخدم غير موجود');
    }

    // التحقق من نوع الإشعار
    const validTypes = [
      'new_order_from_branch',
      'branch_confirmed_receipt',
      'new_order_for_production',
      'order_completed_by_chefs',
      'order_approved_for_branch',
      'order_in_transit_to_branch',
      'new_production_assigned_to_chef',
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    // إنشاء الإشعار
    const notification = new Notification({
      user: userId,
      type,
      message: message.trim(),
      data,
      read: false,
      sound: '/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    });
    await notification.save();

    // إعداد بيانات الحدث
    const eventData = {
      _id: notification._id,
      type: notification.type,
      message: notification.message,
      data: notification.data,
      read: notification.read,
      sound: notification.sound,
      vibrate: notification.vibrate,
      createdAt: notification.createdAt,
      user: {
        _id: targetUser._id,
        username: targetUser.username,
        role: targetUser.role,
        branch: targetUser.branch || null,
        department: targetUser.department || null,
      },
    };

    // تحديد الغرف
    const rooms = new Set([`user-${userId}`]);
    if (targetUser.role === 'admin') rooms.add('admin');
    if (targetUser.role === 'production') rooms.add('production');
    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.add(`branch-${targetUser.branch._id}`);
    if (targetUser.role === 'chef' && targetUser.department?._id) rooms.add(`chef-${targetUser.department._id}`);

    // إضافة غرف إضافية بناءً على النوع
    if (data.branchId) {
      if (['new_order_from_branch', 'order_approved_for_branch', 'order_in_transit_to_branch'].includes(type)) {
        rooms.add(`branch-${data.branchId}`);
      }
    }
    if (data.chefId && type === 'new_production_assigned_to_chef') {
      rooms.add(`chef-${data.chefId}`);
    }

    // إرسال الإشعار إلى الغرف
    rooms.forEach(room => {
      io.of('/api').to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`);
    });

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
    throw err;
  }
};

module.exports = { createNotification };