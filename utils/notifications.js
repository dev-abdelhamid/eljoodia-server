const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    if (!mongoose.isValidObjectId(userId)) {
      console.error(`[${new Date().toISOString()}] Invalid userId for notification: ${userId}`);
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'new_order',
      'order_approved',
      'task_assigned',
      'task_completed',
      'order_status_updated',
      'order_in_transit',
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

    const eventId = `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}-${Date.now()}`;
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

    const soundTypeMap = {
      new_order: 'new_order',
      order_approved: 'order_approved',
      task_assigned: 'task_assigned',
      task_completed: 'task_completed',
      order_status_updated: 'order_status_updated',
      order_in_transit: 'order_in_transit',
      order_delivered: 'order_delivered',
      return_status_updated: 'return_updated',
      missing_assignments: 'missing_assignments',
    };
    const soundType = soundTypeMap[type] || 'notification';
    const notification = new Notification({
      user: userId,
      type,
      message: message.trim(),
      data: { ...data, eventId },
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
      sound: `https://eljoodia-client.vercel.app/sounds/${soundType}.mp3`,
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const rooms = [`user-${userId}`];
    if (targetUser.role === 'admin') rooms.push('admin');
    if (targetUser.role === 'production') rooms.push('production');
    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.push(`branch-${targetUser.branch._id}`);
    if (targetUser.role === 'chef' && data.chefId) rooms.push(`chef-${data.chefId}`);
    if (data.branchId) rooms.push(`branch-${data.branchId}`);

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

const setupNotifications = (io, socket) => {
  const getUsers = async (roles, branchId = null) => {
    const cacheKey = `${roles.join('-')}-${branchId || 'all'}`;
    if (usersCache.has(cacheKey)) return usersCache.get(cacheKey);
    const query = { role: { $in: roles } };
    if (branchId) query.branch = branchId;
    const users = await User.find(query).select('_id username branch').lean();
    usersCache.set(cacheKey, users);
    return users;
  };

  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;
    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
    const eventData = {
      _id: `${orderId}-orderCreated-${Date.now()}`,
      type: 'new_order',
      message: `طلب جديد ${orderNumber} من ${order.branch?.name || 'Unknown'}`,
      data: { orderId, branchId, eventId: `${orderId}-new_order` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/new_order.mp3',
      vibrate: [300, 100, 300],
      timestamp: new Date().toISOString(),
    };
    rooms.forEach(room => io.to(room).emit('newNotification', eventData));
    const adminUsers = await getUsers(['admin']);
    const productionUsers = await getUsers(['production']);
    const branchUsers = branchId ? await getUsers(['branch'], branchId) : [];
    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
      await createNotification(user._id, 'new_order', eventData.message, eventData.data, io);
    }
  };

  const handleOrderApproved = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;
    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
    const eventData = {
      _id: `${orderId}-orderApproved-${Date.now()}`,
      type: 'order_approved',
      message: `تم اعتماد الطلب ${orderNumber} للفرع ${order.branch?.name || 'Unknown'}`,
      data: { orderId, branchId, eventId: `${orderId}-order_approved` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/order_approved.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    rooms.forEach(room => io.to(room).emit('newNotification', eventData));
    const users = await getUsers(['admin', 'production', 'branch'], branchId);
    for (const user of users) {
      await createNotification(user._id, 'order_approved', eventData.message, eventData.data, io);
    }
  };

  const handleTaskAssigned = async (data) => {
    const { taskId, orderId, chefId, orderNumber, branchId, productName } = data;
    const eventData = {
      _id: `${taskId}-taskAssigned-${Date.now()}`,
      type: 'task_assigned',
      message: `تم تعيينك لإنتاج ${productName} في الطلب ${orderNumber}`,
      data: { taskId, orderId, chefId, branchId, eventId: `${taskId}-task_assigned` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/task_assigned.mp3',
      vibrate: [400, 100, 400],
      timestamp: new Date().toISOString(),
    };
    io.to(`chef-${chefId}`).emit('newNotification', eventData);
    await createNotification(chefId, 'task_assigned', eventData.message, eventData.data, io);
  };

  const handleTaskCompleted = async (data) => {
    const { taskId, orderId, chefId, orderNumber, branchId, productName } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      _id: `${taskId}-taskCompleted-${Date.now()}`,
      type: 'task_completed',
      message: `تم إكمال إنتاج ${productName} في الطلب ${orderNumber}`,
      data: { taskId, orderId, chefId, branchId, eventId: `${taskId}-task_completed` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/task_completed.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    const rooms = new Set(['admin', 'production', `branch-${branchId}`, `chef-${chefId}`]);
    rooms.forEach(room => io.to(room).emit('newNotification', eventData));
    const users = await getUsers(['admin', 'production', 'branch'], branchId);
    for (const user of [...users, { _id: chefId }]) {
      await createNotification(user._id, 'task_completed', eventData.message, eventData.data, io);
    }
  };

  const handleOrderInTransit = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      _id: `${orderId}-orderInTransit-${Date.now()}`,
      type: 'order_in_transit',
      message: `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'Unknown'}`,
      data: { orderId, branchId, eventId: `${orderId}-order_in_transit` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/order_in_transit.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
    rooms.forEach(room => io.to(room).emit('newNotification', eventData));
    const users = await getUsers(['admin', 'production', 'branch'], branchId);
    for (const user of users) {
      await createNotification(user._id, 'order_in_transit', eventData.message, eventData.data, io);
    }
  };

  const handleOrderDelivered = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      _id: `${orderId}-orderDelivered-${Date.now()}`,
      type: 'order_delivered',
      message: `تم تسليم الطلب ${orderNumber} إلى ${order.branch?.name || 'Unknown'}`,
      data: { orderId, branchId, eventId: `${orderId}-order_delivered` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/order_delivered.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
    rooms.forEach(room => io.to(room).emit('newNotification', eventData));
    const users = await getUsers(['admin', 'production', 'branch'], branchId);
    for (const user of users) {
      await createNotification(user._id, 'order_delivered', eventData.message, eventData.data, io);
    }
  };

  const handleReturnStatusUpdated = async (data) => {
    const { returnId, orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      _id: `${returnId}-returnStatusUpdated-${Date.now()}`,
      type: 'return_status_updated',
      message: `تم تحديث حالة طلب الإرجاع ${orderNumber} للفرع ${order.branch?.name || 'Unknown'}`,
      data: { returnId, orderId, branchId, eventId: `${returnId}-return_status_updated` },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/return_updated.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
    rooms.forEach(room => io.to(room).emit('newNotification', eventData));
    const users = await getUsers(['admin', 'production', 'branch'], branchId);
    for (const user of users) {
      await createNotification(user._id, 'return_status_updated', eventData.message, eventData.data, io);
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('orderApproved', handleOrderApproved);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('taskCompleted', handleTaskCompleted);
  socket.on('orderInTransit', handleOrderInTransit);
  socket.on('orderDelivered', handleOrderDelivered);
  socket.on('returnStatusUpdated', handleReturnStatusUpdated);
};

module.exports = { createNotification, setupNotifications };