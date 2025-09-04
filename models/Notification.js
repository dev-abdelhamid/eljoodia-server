const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

// دالة لإنشاء إشعار (بدون تغيير)
const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    const notification = new Notification({
      user: userId,
      type,
      message,
      data: {
        ...data,
        eventId: data.eventId || `${data.orderId || data.taskId || 'generic'}-${type}-${userId}`,
      },
    });
    await notification.save();
    console.log(`[${new Date().toISOString()}] Created notification for user ${userId}:`, { type, message, data });
    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification for user ${userId}:`, {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
};

// دالة جديدة لتوحيد الإشعارات والـ socket events
const sendNotificationAndEvent = async (io, type, message, data, rooms) => {
  try {
    const eventData = {
      _id: `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${Date.now()}`,
      type,
      message,
      data: { ...data, eventId: `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: `https://eljoodia-client.vercel.app/sounds/${getSoundType(type)}.mp3`,
      vibrate: type === 'taskAssigned' ? [400, 100, 400] : [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    // جلب المستخدمين المستهدفين
    const usersToNotify = await getUsersToNotify(type, data);

    // إنشاء إشعارات لكل مستخدم
    for (const user of usersToNotify) {
      await createNotification(user._id, type, message, eventData.data, io);
    }

    // إرسال الـ socket event
    const uniqueRooms = [...new Set(rooms)];
    uniqueRooms.forEach(room => io.to(room).emit('newNotification', eventData));
    console.log(`[${new Date().toISOString()}] Sent unified notification for ${type} to rooms: ${uniqueRooms.join(', ')}`, {
      eventData,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in sendNotificationAndEvent:`, {
      error: err.message,
      stack: err.stack,
    });
  }
};

// دالة لتحديد نوع الصوت بناءً على نوع الإشعار
const getSoundType = (type) => {
  const soundTypeMap = {
    taskAssigned: 'task_assigned',
    taskStatusUpdated: 'task_status_updated',
    taskCompleted: 'task_completed',
    itemStatusUpdated: 'item_status_updated',
    orderStatusUpdated: 'order_status_updated',
    orderCompleted: 'order_completed',
    new_order_from_branch: 'notification',
    order_approved_for_branch: 'notification',
    order_in_transit_to_branch: 'notification',
    order_completed_by_chefs: 'notification',
    return_status_updated: 'notification',
  };
  return soundTypeMap[type] || 'notification';
};

// دالة لجلب المستخدمين المستهدفين بناءً على نوع الإشعار
const getUsersToNotify = async (type, data) => {
  const { branchId, chefId, orderId } = data;
  const order = orderId ? await Order.findById(orderId).select('branch').lean() : null;
  const branch = branchId || order?.branch;

  const queries = [
    User.find({ role: 'admin' }).select('_id').lean(),
    User.find({ role: 'production' }).select('_id').lean(),
  ];

  if (branch) queries.push(User.find({ role: 'branch', branch }).select('_id').lean());
  if (chefId) queries.push(User.find({ _id: chefId }).select('_id').lean());

  const [admins, production, branches, chefs] = await Promise.all(queries);
  let users = [...admins, ...production, ...(branches || []), ...(chefs || [])];

  // إزالة التكرار بناءً على _id
  users = users.filter((u, index, self) => self.findIndex(t => t._id.toString() === u._id.toString()) === index);

  console.log(`[${new Date().toISOString()}] Users to notify for ${type}:`, {
    userIds: users.map(u => u._id.toString()),
    branchId: branch?.toString(),
    chefId: chefId?.toString(),
  });

  return users;
};

// دالة لمعالجة الأحداث بشكل عام
const handleNotificationEvent = async (io, type, data) => {
  const { orderId, orderNumber, branchId, taskId, chefId, productId, productName, quantity, status, returnId } = data;

  const order = orderId ? await Order.findById(orderId).populate('branch', 'name').lean() : null;
  if (!order && ['orderCreated', 'orderApproved', 'taskAssigned', 'taskCompleted', 'branchConfirmed', 'orderInTransit', 'orderDelivered', 'returnStatusUpdated'].includes(type)) {
    console.error(`[${new Date().toISOString()}] Order not found for ${type}: ${orderId}`);
    return;
  }

  const messageMap = {
    orderCreated: `طلب جديد ${orderNumber} من ${order?.branch?.name || 'Unknown'}`,
    orderApproved: `تم اعتماد الطلب ${orderNumber} لـ ${order?.branch?.name || 'Unknown'}`,
    taskAssigned: `تم تعيين مهمة جديدة لك في الطلب ${order?.orderNumber || 'Unknown'}`,
    taskCompleted: `تم إكمال مهمة (${productName || 'Unknown'}) في الطلب ${order?.orderNumber || 'Unknown'}`,
    branchConfirmed: `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order?.branch?.name || 'Unknown'}`,
    orderInTransit: `الطلب ${orderNumber} في طريقه إلى ${order?.branch?.name || 'Unknown'}`,
    orderDelivered: `تم تسليم الطلب ${orderNumber} إلى ${order?.branch?.name || 'Unknown'}`,
    returnStatusUpdated: `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${order?.orderNumber || 'Unknown'}`,
    new_order_from_branch: `طلب جديد ${orderNumber} تم إنشاؤه بواسطة ${order?.createdBy?.username || 'Unknown'} للفرع ${order?.branch?.name || 'Unknown'}`,
    order_approved_for_branch: `تم اعتماد الطلب ${orderNumber} للفرع ${order?.branch?.name || 'Unknown'}`,
    order_in_transit_to_branch: `الطلب ${orderNumber} في الطريق إلى ${order?.branch?.name || 'Unknown'}`,
    order_completed_by_chefs: `تم إكمال الطلب ${orderNumber} بواسطة الشيفات`,
  };

  const message = messageMap[type];
  if (!message) {
    console.error(`[${new Date().toISOString()}] No message defined for type: ${type}`);
    return;
  }

  const rooms = ['admin', 'production'];
  if (branchId) rooms.push(`branch-${branchId}`);
  if (chefId) rooms.push(`chef-${chefId}`);
  if (data.departmentId) rooms.push(`department-${data.departmentId}`);
  rooms.push('all-departments');

  await sendNotificationAndEvent(io, type, message, data, rooms);
};

// إعداد الإشعارات وتوصيلات Socket.IO
const setupNotifications = (io, socket) => {
  // الانضمام إلى الغرف بناءً على بيانات المستخدم
  socket.on('joinRoom', (data) => {
    const { userId, role, branchId, chefId, departmentId } = data;
    if (!userId) {
      console.error(`[${new Date().toISOString()}] Invalid userId for joinRoom:`, data);
      return;
    }

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

  // معالجة الأحداث باستخدام الدالة العامة
  socket.on('orderCreated', (data) => handleNotificationEvent(io, 'orderCreated', data));
  socket.on('orderApproved', (data) => handleNotificationEvent(io, 'orderApproved', data));
  socket.on('taskAssigned', (data) => handleNotificationEvent(io, 'taskAssigned', data));
  socket.on('taskCompleted', (data) => handleNotificationEvent(io, 'taskCompleted', data));
  socket.on('branchConfirmed', (data) => handleNotificationEvent(io, 'branchConfirmed', data));
  socket.on('orderInTransit', (data) => handleNotificationEvent(io, 'orderInTransit', data));
  socket.on('orderDelivered', (data) => handleNotificationEvent(io, 'orderDelivered', data));
  socket.on('returnStatusUpdated', (data) => handleNotificationEvent(io, 'returnStatusUpdated', data));
  socket.on('new_order_from_branch', (data) => handleNotificationEvent(io, 'new_order_from_branch', data));
  socket.on('order_approved_for_branch', (data) => handleNotificationEvent(io, 'order_approved_for_branch', data));
  socket.on('order_in_transit_to_branch', (data) => handleNotificationEvent(io, 'order_in_transit_to_branch', data));
  socket.on('order_completed_by_chefs', (data) => handleNotificationEvent(io, 'order_completed_by_chefs', data));
};

module.exports = { createNotification, setupNotifications, sendNotificationAndEvent };