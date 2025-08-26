const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

// ذاكرة مؤقتة داخلية لتخزين أسماء الفروع
const cache = new Map();

// جلب اسم الفرع من الذاكرة المؤقتة أو قاعدة البيانات
const getBranchName = async (branchId, session = null) => {
  if (!branchId) return 'Unknown';
  if (cache.has(branchId)) {
    return cache.get(branchId);
  }
  const branch = await mongoose.model('Branch').findById(branchId).select('name').lean().session(session);
  const branchName = branch?.name || 'Unknown';
  cache.set(branchId, branchName);
  return branchName;
};

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Creating notification for user ${userId}:`, { type, message, data });

    // التحقق من صحة المعرف
    if (!mongoose.isValidObjectId(userId)) {
      console.error(`[${timestamp}] Invalid userId for notification: ${userId}`);
      throw new Error('معرف المستخدم غير صالح');
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
      'order_status_updated',
      'task_assigned',
      'task_completed',
      'task_status_updated',
      'item_status_updated',
      'order_completed',
      'order_delivered',
      'return_status_updated',
      'missing_assignments',
    ];

    if (!validTypes.includes(type)) {
      console.error(`[${timestamp}] Invalid notification type: ${type}`);
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    // التحقق من Socket.IO
    if (!io || typeof io.of !== 'function') {
      console.error(`[${timestamp}] Invalid Socket.IO instance`);
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    // التحقق من عدم وجود إشعار مكرر خلال 5 ثوان
    const recentNotification = await Notification.findOne({
      user: userId,
      type,
      message,
      createdAt: { $gte: new Date(Date.now() - 5000) },
    }).lean();

    if (recentNotification) {
      console.warn(`[${timestamp}] Duplicate notification detected for user ${userId}:`, { type, message });
      return recentNotification;
    }

    // جلب بيانات المستخدم
    const targetUser = await User.findById(userId)
      .select('username role branch isActive')
      .populate('branch', 'name')
      .lean();

    if (!targetUser) {
      console.error(`[${timestamp}] User not found for notification: ${userId}`);
      throw new Error('المستخدم غير موجود');
    }

    if (targetUser.isActive === false) {
      console.warn(`[${timestamp}] Skipping notification for inactive user: ${userId}`);
      return null;
    }

    // إنشاء الإشعار
    const notification = new Notification({
      user: userId,
      type,
      message: message.trim(),
      data,
      read: false,
      createdAt: new Date(),
    });

    await notification.save();

    // جلب الإشعار مع البيانات المملوءة
    const populatedNotification = await Notification.findById(notification._id)
      .select('user type message data read createdAt')
      .populate('user', 'username role branch')
      .lean();

    // إعداد بيانات الحدث
    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia.vercel.app';
    const branchName = await getBranchName(data.branchId || targetUser.branch?._id);
    const eventData = {
      _id: notification._id,
      type: notification.type,
      message: notification.message,
      data: {
        ...notification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        branchName,
        taskId: data.taskId,
        orderId: data.orderId,
        orderNumber: data.orderNumber,
        chefId: data.chefId,
        productName: data.productName,
        quantity: data.quantity,
        itemId: data.itemId,
        status: data.status,
      },
      read: notification.read,
      user: {
        _id: populatedNotification.user._id,
        username: populatedNotification.user.username,
        role: populatedNotification.user.role,
        branch: populatedNotification.user.branch || null,
      },
      createdAt: notification.createdAt,
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [200, 100, 200],
      timestamp,
    };

    // تحديد الغرف
    const rooms = [`user-${userId}`];
    if (targetUser.role === 'admin') rooms.push('admin');
    if (targetUser.role === 'production') rooms.push('production');
    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.push(`branch-${targetUser.branch._id}`);
    if (targetUser.role === 'chef' && data.chefId) rooms.push(`chef-${data.chefId}`);
    if (data.branchId) rooms.push(`branch-${data.branchId}`);
    if (data.departmentId) rooms.push(`department-${data.departmentId}`);
    rooms.push('all-departments');

    // إرسال الحدث إلى الغرف
    const eventName = {
      'new_order_from_branch': 'newOrderFromBranch',
      'branch_confirmed_receipt': 'branchConfirmedReceipt',
      'new_order_for_production': 'newOrderForProduction',
      'order_completed_by_chefs': 'orderCompletedByChefs',
      'order_approved_for_branch': 'orderApprovedForBranch',
      'order_in_transit_to_branch': 'orderInTransitToBranch',
      'new_production_assigned_to_chef': 'newProductionAssignedToChef',
      'order_status_updated': 'orderStatusUpdated',
      'task_assigned': 'taskAssigned',
      'task_completed': 'taskCompleted',
      'task_status_updated': 'taskStatusUpdated',
      'item_status_updated': 'itemStatusUpdated',
      'order_completed': 'orderCompleted',
      'order_delivered': 'orderDelivered',
      'return_status_updated': 'returnStatusUpdated',
      'missing_assignments': 'missingAssignments',
    }[type] || 'newNotification';

    rooms.forEach(room => {
      io.of('/api').to(room).emit(eventName, eventData);
      console.log(`[${timestamp}] Notification sent to room: ${room}`, { eventName, eventData });
    });

    return notification;
  } catch (err) {
    console.error(`[${timestamp}] Error creating notification:`, {
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
  // تهيئة الغرف فقط بناءً على بيانات المستخدم
  const user = socket.user;
  if (!user) {
    console.error(`[${new Date().toISOString()}] No user data for socket: ${socket.id}`);
    return;
  }

  const rooms = [
    `user-${user.id}`,
    user.role,
    ...(user.role === 'branch' && user.branchId ? [`branch-${user.branchId}`] : []),
    ...(user.role === 'chef' ? [`chef-${user.id}`] : []),
    ...(user.departmentId ? [`department-${user.departmentId}`] : []),
    'all-departments',
  ];

  rooms.forEach(room => {
    socket.join(room);
    console.log(`[${new Date().toISOString()}] User ${user.username} (${user.id}) joined room: ${room}`);
  });
};

module.exports = { createNotification, setupNotifications };