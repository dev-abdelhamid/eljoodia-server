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

const setupNotifications = (io, socket) => {

  const handleOrderCreated = async (data) => {

    const { orderId, orderNumber, branchId, items } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production']);

    if (branchId) rooms.add(`branch-${branchId}`);

    const eventData = {

      _id: `${orderId}-orderCreated-${Date.now()}`,

      type: 'new_order_from_branch',

      message: `طلب جديد ${orderNumber} من ${order.branch?.name || 'Unknown'}`,

      data: { orderId, branchId, eventId: `${orderId}-new_order_from_branch` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia-client.vercel.app/sounds/new_order.mp3',

      soundType: 'new_order',

      vibrate: [300, 100, 300],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for orderCreated to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const branchUsers = branchId ? await User.find({ role: 'branch', branch: branchId }).select('_id').lean() : [];

    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {

      await createNotification(user._id, 'new_order_from_branch', eventData.message, eventData.data, io);

    }

  };

  const handleOrderApproved = async (data) => {

    const { orderId, orderNumber, branchId } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);

    const eventData = {

      _id: `${orderId}-orderApproved-${Date.now()}`,

      type: 'order_approved_for_branch',

      message: `تم اعتماد الطلب ${orderNumber} لـ ${order.branch?.name || 'Unknown'}`,

      data: { orderId, branchId, eventId: `${orderId}-order_approved_for_branch` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',

      soundType: 'order_approved',

      vibrate: [200, 100, 200],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for orderApproved to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {

      await createNotification(user._id, 'order_approved_for_branch', eventData.message, eventData.data, io);

    }

  };

  const handleTaskAssigned = async (data) => {

    const { orderId, taskId, chefId, productId, productName, quantity, branchId } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production', `chef-${chefId}`]);

    if (order.branch) rooms.add(`branch-${order.branch._id}`);

    const eventData = {

      _id: `${orderId}-taskAssigned-${Date.now()}`,

      type: 'new_production_assigned_to_chef',

      message: `تم تعيين مهمة جديدة لك في الطلب ${order.orderNumber || 'Unknown'}`,

      data: { orderId, taskId, branchId: order.branch?._id || branchId, chefId, productId, productName, quantity, eventId: `${taskId}-new_production_assigned_to_chef` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',

      soundType: 'task_assigned',

      vibrate: [400, 100, 400],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for taskAssigned to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

    const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

    for (const user of [...adminUsers, ...productionUsers, ...chefUsers, ...branchUsers]) {

      await createNotification(user._id, 'new_production_assigned_to_chef', eventData.message, eventData.data, io);

    }

  };

  const handleTaskCompleted = async (data) => {

    const { orderId, taskId, chefId, productName } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production', `chef-${chefId}`]);

    if (order.branch) rooms.add(`branch-${order.branch._id}`);

    const eventData = {

      _id: `${orderId}-taskCompleted-${Date.now()}`,

      type: 'order_completed_by_chefs',

      message: `تم إكمال مهمة (${productName || 'Unknown'}) في الطلب ${order.orderNumber || 'Unknown'}`,

      data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-order_completed_by_chefs` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',

      soundType: 'task_completed',

      vibrate: [200, 100, 200],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for taskCompleted to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {

      await createNotification(user._id, 'order_completed_by_chefs', eventData.message, eventData.data, io);

    }

  };

  const handleOrderConfirmed = async (data) => {

    const { orderId, orderNumber, branchId } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);

    const eventData = {

      _id: `${orderId}-branchConfirmed-${Date.now()}`,

      type: 'branch_confirmed_receipt',

      message: `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'Unknown'}`,

      data: { orderId, branchId, eventId: `${orderId}-branch_confirmed_receipt` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',

      soundType: 'order_delivered',

      vibrate: [200, 100, 200],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for branchConfirmed to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {

      await createNotification(user._id, 'branch_confirmed_receipt', eventData.message, eventData.data, io);

    }

  };

  const handleOrderInTransit = async (data) => {

    const { orderId, orderNumber, branchId } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);

    const eventData = {

      _id: `${orderId}-orderInTransit-${Date.now()}`,

      type: 'order_in_transit_to_branch',

      message: `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'Unknown'}`,

      data: { orderId, branchId, eventId: `${orderId}-order_in_transit_to_branch` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',

      soundType: 'order_in_transit',

      vibrate: [300, 100, 300],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for orderInTransit to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {

      await createNotification(user._id, 'order_in_transit_to_branch', eventData.message, eventData.data, io);

    }

  };

  const handleOrderDelivered = async (data) => {

    const { orderId, orderNumber, branchId } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);

    const eventData = {

      _id: `${orderId}-orderDelivered-${Date.now()}`,

      type: 'order_delivered',

      message: `تم تسليم الطلب ${orderNumber} إلى ${order.branch?.name || 'Unknown'}`,

      data: { orderId, branchId, eventId: `${orderId}-order_delivered` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',

      soundType: 'order_delivered',

      vibrate: [300, 100, 300],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for orderDelivered to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {

      await createNotification(user._id, 'order_delivered', eventData.message, eventData.data, io);

    }

  };

  const handleReturnStatusUpdated = async (data) => {

    const { returnId, orderId, status, branchId } = data;

    const order = await Order.findById(orderId).populate('branch', 'name').lean();

    if (!order) return;

    const rooms = new Set(['admin', 'production', `branch-${branchId}`]);

    const eventData = {

      _id: `${returnId}-returnStatusUpdated-${Date.now()}`,

      type: 'return_status_updated',

      message: `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${order.orderNumber || 'Unknown'}`,

      data: { returnId, orderId, branchId, eventId: `${returnId}-return_status_updated` },

      read: false,

      createdAt: new Date().toISOString(),

      sound: 'https://eljoodia.vercel.app/sounds/notification.mp3',

      soundType: 'return_updated',

      vibrate: [200, 100, 200],

      timestamp: new Date().toISOString(),

    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    console.log(`[${new Date().toISOString()}] Emitted newNotification for returnStatusUpdated to rooms: ${[...rooms].join(', ')}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();

    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

    for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {

      await createNotification(user._id, 'return_status_updated', eventData.message, eventData.data, io);

    }

  };

  socket.on('orderCreated', handleOrderCreated);

  socket.on('orderApproved', handleOrderApproved);

  socket.on('taskAssigned', handleTaskAssigned);

  socket.on('taskCompleted', handleTaskCompleted);

  socket.on('branchConfirmed', handleOrderConfirmed);

  socket.on('orderInTransit', handleOrderInTransit);

  socket.on('orderDelivered', handleOrderDelivered);

  socket.on('returnStatusUpdated', handleReturnStatusUpdated);

};

module.exports = { createNotification, setupNotifications };