const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = false, lang = 'ar') => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data, saveToDb });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error(lang === 'ar' ? 'معرف المستخدم غير صالح' : 'Invalid user ID');
    }

    const validTypes = [
      'orderCreated', 'orderCompleted', 'taskAssigned', 'orderApproved',
      'orderInTransit', 'orderDelivered', 'branchConfirmedReceipt',
      'taskStarted', 'taskCompleted', 'returnCreated', 'returnStatusUpdated'
    ];
    if (!validTypes.includes(type)) {
      throw new Error(lang === 'ar' ? `نوع الإشعار غير صالح: ${type}` : `Invalid notification type: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error(lang === 'ar' ? 'خطأ في تهيئة Socket.IO' : 'Socket.IO not initialized');
    }

    const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}`;
    if (saveToDb) {
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
      if (existingNotification) {
        console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
        return existingNotification;
      }
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate({ path: 'branch', select: 'name nameEn', options: { context: { isRtl: lang === 'ar' } } })
      .lean();

    if (!targetUser) {
      throw new Error(lang === 'ar' ? 'المستخدم غير موجود' : 'User not found');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    let notification;
    if (saveToDb) {
      notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: typeof message === 'string' ? message.trim() : (lang === 'ar' ? message.ar : message.en).trim(),
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id)
          .populate('user', 'username role branch')
          .setOptions({ context: { isRtl: lang === 'ar' } })
          .lean()
      : { 
          _id: uuidv4(), 
          user: targetUser, 
          type, 
          message: typeof message === 'string' ? message : (lang === 'ar' ? message.ar : message.en), 
          data: { ...data, eventId }, 
          read: false, 
          createdAt: new Date() 
        };

    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      message: populatedNotification.message,
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        branchName: targetUser.branch?.displayName || targetUser.branch?.name || 'N/A',
        orderId: data.orderId,
        taskId: data.taskId,
        chefId: data.chefId,
        returnId: data.returnId,
      },
      read: populatedNotification.read,
      user: {
        _id: targetUser._id,
        username: targetUser.username,
        role: targetUser.role,
        branch: targetUser.branch || null,
      },
      createdAt: new Date(populatedNotification.createdAt).toISOString(),
      sound: `${baseUrl}/sounds/notification.mp3`,
      soundType: 'notification',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
      taskAssigned: ['admin', 'production', 'chef'],
      orderApproved: ['admin', 'production', 'branch'],
      orderInTransit: ['admin', 'production', 'branch'],
      orderDelivered: ['admin', 'production', 'branch'],
      branchConfirmedReceipt: ['admin', 'production', 'branch'],
      taskStarted: ['admin', 'production', 'chef'],
      taskCompleted: ['admin', 'production', 'chef'],
      returnCreated: ['admin', 'production', 'branch'],
      returnStatusUpdated: ['admin', 'production', 'branch'],
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && (data.branchId || targetUser.branch?._id)) rooms.add(`branch-${data.branchId || targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
    });

    return notification || populatedNotification;
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

module.exports = { createNotification };