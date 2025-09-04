const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data });

    if (!mongoose.isValidObjectId(userId)) {
      console.error(`[${new Date().toISOString()}] Invalid userId for notification: ${userId}`);
      throw new Error('معرف المستخدم غير صالح');
    }

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
      'order_completed',
      'order_delivered',
      'return_status_updated',
      'missing_assignments',
    ];

    if (!validTypes.includes(type)) {
      console.error(`[${new Date().toISOString()}] Invalid notification type: ${type}`);
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      console.error(`[${new Date().toISOString()}] Invalid Socket.IO instance`);
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    // التحقق من عدم وجود إشعار مكرر
    const eventId = `${data.orderId || data.taskId || data.returnId}-${type}-${userId}`;
    const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
    if (existingNotification) {
      console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
      return existingNotification;
    }

    const targetUser = await User.findById(userId)
      .select('username role branch')
      .populate('branch', 'name')
      .lean();

    if (!targetUser) {
      console.error(`[${new Date().toISOString()}] User not found for notification: ${userId}`);
      throw new Error('المستخدم غير موجود');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    const soundTypeMap = {
      new_order_from_branch: 'new_order',
      order_approved_for_branch: 'order_approved',
      new_production_assigned_to_chef: 'task_assigned',
      order_completed_by_chefs: 'task_completed',
      order_in_transit_to_branch: 'order_in_transit',
      order_delivered: 'order_delivered',
      branch_confirmed_receipt: 'order_delivered',
      return_status_updated: 'return_updated',
      order_status_updated: 'order_status_updated',
      task_assigned: 'task_assigned',
      order_completed: 'order_completed',
    };
    const soundType = soundTypeMap[type] || 'default';
    const notification = new Notification({
      user: userId,
      type,
      message: message.trim(),
      data,
      read: false,
      createdAt: new Date(),
    });


    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)

      .select('user type message data read createdAt')

      .populate('user', 'username role branch')

      .lean();

    const eventData = {

      _id: notification._id,

      type: notification.type,

      message: notification.message,

      data: {

        ...notification.data,

        branchId: data.branchId || targetUser.branch?._id?.toString(),

        taskId: data.taskId,

        orderId: data.orderId,

        chefId: data.chefId,

      },

      read: notification.read,

      user: {

        _id: populatedNotification.user._id,

        username: populatedNotification.user.username,

        role: populatedNotification.user.role,

        branch: populatedNotification.user.branch || null,

      },

      createdAt: notification.createdAt,

      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',

      vibrate: [200, 100, 200],

      timestamp: new Date().toISOString(),

    };

    const rooms = [`user-${userId}`];

    if (targetUser.role === 'admin') rooms.push('admin');

    if (targetUser.role === 'production') rooms.push('production');

    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.push(`branch-${targetUser.branch._id}`);

    if (targetUser.role === 'chef' && data.chefId) rooms.push(`chef-${data.chefId}`);

    if (data.branchId) rooms.push(`branch-${data.branchId}`);

    if (data.departmentId) rooms.push(`department-${data.departmentId}`);

    rooms.push('all-departments');

    rooms.forEach(room => {

      io.to(room).emit('newNotification', eventData);

      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);

    });

    return notification;

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

// دالة جديدة لجلب المستخدمين المستهدفين بناءً على النوع والـ data
const getUsersToNotify = async (type, data) => {
  const { branchId, chefId } = data;
  const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
  const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
  const branchUsers = branchId ? await User.find({ role: 'branch', branch: branchId }).select('_id').lean() : [];
  const chefUsers = chefId ? await User.find({ _id: chefId }).select('_id').lean() : [];

  let users = [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers];

  // حسب النوع، أضف مستخدمين إضافيين إذا لزم
  if (type === 'new_production_assigned_to_chef') {
    // أضف مستخدمين من الأقسام إذا كان هناك departmentId
    if (data.departmentId) {
      const departmentUsers = await User.find({ department: data.departmentId }).select('_id').lean();
      users = [...users, ...departmentUsers];
    }
  }

  // إزالة التكرار
  users = users.filter((user, index, self) => self.findIndex(u => u._id.toString() === user._id.toString()) === index);

  return users;
};

// دالة عامة لمعالجة الأحداث والإشعارات
const handleNotificationEvent = async (io, type, data) => {
  const { orderId, orderNumber, branchId, taskId, chefId, productId, productName, quantity, status, returnId } = data;

  const order = await Order.findById(orderId).populate('branch', 'name').lean();
  if (!order) {
    console.warn(`[${new Date().toISOString()}] Order not found for ${type}: ${orderId}`);
    return;
  }

  const eventConfig = {
    orderCreated: {
      type: 'new_order_from_branch',
      message: `طلب جديد ${orderNumber} من ${order.branch?.name || 'Unknown'}`,
      soundType: 'new_order',
      vibrate: [300, 100, 300],
    },
    orderApproved: {
      type: 'order_approved_for_branch',
      message: `تم اعتماد الطلب ${orderNumber} لـ ${order.branch?.name || 'Unknown'}`,
      soundType: 'order_approved',
      vibrate: [200, 100, 200],
    },
    taskAssigned: {
      type: 'new_production_assigned_to_chef',
      message: `تم تعيين مهمة جديدة لك في الطلب ${order.orderNumber || 'Unknown'}`,
      soundType: 'task_assigned',
      vibrate: [400, 100, 400],
    },
    taskCompleted: {
      type: 'order_completed_by_chefs',
      message: `تم إكمال مهمة (${productName || 'Unknown'}) في الطلب ${order.orderNumber || 'Unknown'}`,
      soundType: 'task_completed',
      vibrate: [200, 100, 200],
    },
    branchConfirmed: {
      type: 'branch_confirmed_receipt',
      message: `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'Unknown'}`,
      soundType: 'order_delivered',
      vibrate: [200, 100, 200],
    },
    orderInTransit: {
      type: 'order_in_transit_to_branch',
      message: `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'Unknown'}`,
      soundType: 'order_in_transit',
      vibrate: [300, 100, 300],
    },
    orderDelivered: {
      type: 'order_delivered',
      message: `تم تسليم الطلب ${orderNumber} إلى ${order.branch?.name || 'Unknown'}`,
      soundType: 'order_delivered',
      vibrate: [300, 100, 300],
    },
    returnStatusUpdated: {
      type: 'return_status_updated',
      message: `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${order.orderNumber || 'Unknown'}`,
      soundType: 'return_updated',
      vibrate: [200, 100, 200],
    },
  };

  const config = eventConfig[type];
  if (!config) {
    console.error(`[${new Date().toISOString()}] Invalid event type: ${type}`);
    return;
  }

  const eventData = {
    _id: `${orderId || returnId || taskId}-${type}-${Date.now()}`,
    type: config.type,
    message: config.message,
    data: { ...data, eventId: `${orderId || returnId || taskId}-${config.type}` },
    read: false,
    createdAt: new Date().toISOString(),
    sound: `https://eljoodia-client.vercel.app/sounds/${config.soundType || 'notification'}.mp3`,
    soundType: config.soundType || 'default',
    vibrate: config.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
  };

  // جلب المستخدمين المستهدفين
  const usersToNotify = await getUsersToNotify(type, data);

  // جلب الغرف
  const rooms = new Set(['admin', 'production']);
  if (branchId) rooms.add(`branch-${branchId}`);
  if (chefId) rooms.add(`chef-${chefId}`);
  if (order.branch?._id) rooms.add(`branch-${order.branch._id}`);
  if (data.departmentId) rooms.add(`department-${data.departmentId}`);
  rooms.add('all-departments');

  // إرسال الإشعار والـ event
  rooms.forEach(room => io.to(room).emit('newNotification', eventData));
  console.log(`[${new Date().toISOString()}] Emitted newNotification for ${type} to rooms: ${[...rooms].join(', ')}`);

  for (const user of usersToNotify) {
    await createNotification(user._id, config.type, config.message, eventData.data, io);
  }
};

const setupNotifications = (io, socket) => {
  // listener للانضمام للغرف لضمان التوافق اللحظي
  socket.on('joinRoom', (data) => {
    const { userId, role, branchId, chefId, departmentId } = data;
    const rooms = [`user-${userId}`];
    if (role === 'admin') rooms.push('admin');
    if (role === 'production') rooms.push('production');
    if (role === 'branch' && branchId) rooms.push(`branch-${branchId}`);
    if (role === 'chef' && chefId) rooms.push(`chef-${chefId}`);
    if (departmentId) rooms.push(`department-${departmentId}`);
    rooms.push('all-departments');

    rooms.forEach(room => socket.join(room));
    console.log(`[${new Date().toISOString()}] User ${userId} joined rooms: ${rooms.join(', ')}`);
  });

  // استخدام الدالة العامة لكل حدث
  socket.on('orderCreated', (data) => handleNotificationEvent(io, 'orderCreated', data));
  socket.on('orderApproved', (data) => handleNotificationEvent(io, 'orderApproved', data));
  socket.on('taskAssigned', (data) => handleNotificationEvent(io, 'taskAssigned', data));
  socket.on('taskCompleted', (data) => handleNotificationEvent(io, 'taskCompleted', data));
  socket.on('branchConfirmed', (data) => handleNotificationEvent(io, 'branchConfirmed', data));
  socket.on('orderInTransit', (data) => handleNotificationEvent(io, 'orderInTransit', data));
  socket.on('orderDelivered', (data) => handleNotificationEvent(io, 'orderDelivered', data));
  socket.on('returnStatusUpdated', (data) => handleNotificationEvent(io, 'returnStatusUpdated', data));
};

module.exports = { createNotification, setupNotifications };