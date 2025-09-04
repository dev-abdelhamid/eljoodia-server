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
      'new_production_assigned_to_chef',
      'order_completed_by_chefs',
      'order_approved_for_branch',
      'order_in_transit_to_branch',
      'order_delivered',
      'return_status_updated',
      'order_status_updated',
      'item_status_updated',
      'task_assigned',
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
    const eventId = `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}`;
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
      item_status_updated: 'item_status_updated',
      task_assigned: 'task_assigned',
      missing_assignments: 'missing_assignments',
    };
    const soundType = soundTypeMap[type] || 'default';
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
      sound: `${baseUrl}/sounds/${soundType}.mp3`,
      soundType,
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    const rooms = new Set([`user-${userId}`]);
    if (targetUser.role === 'admin') rooms.add('admin');
    if (targetUser.role === 'production') rooms.add('production');
    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.add(`branch-${targetUser.branch._id}`);
    if (targetUser.role === 'chef' && data.chefId) rooms.add(`chef-${data.chefId}`);
    if (data.branchId) rooms.add(`branch-${data.branchId}`);
    if (data.departmentId) rooms.add(`department-${data.departmentId}`);
    const eventNameMap = {
      new_order_from_branch: 'newOrderFromBranch',
      order_approved_for_branch: 'orderApprovedForBranch',
      new_production_assigned_to_chef: 'newProductionAssignedToChef',
      order_completed_by_chefs: 'orderCompletedByChefs',
      order_in_transit_to_branch: 'orderInTransitToBranch',
      order_delivered: 'orderDelivered',
      branch_confirmed_receipt: 'branchConfirmedReceipt',
      return_status_updated: 'returnStatusUpdated',
      order_status_updated: 'orderStatusUpdated',
      item_status_updated: 'itemStatusUpdated',
      task_assigned: 'taskAssigned',
      missing_assignments: 'missingAssignments',
    };
    const socketEvent = eventNameMap[type] || 'newNotification';
    rooms.forEach(room => {
      io.to(room).emit(socketEvent, eventData);
      console.log(`[${new Date().toISOString()}] Emitted ${socketEvent} to room: ${room}`, eventData);
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
  const emitToRooms = (rooms, eventName, eventData) => {
    rooms.forEach(room => {
      io.to(room).emit(eventName, eventData);
      console.log(`[${new Date().toISOString()}] Emitted ${eventName} to room: ${room}`);
    });
  };

  const notifyUsers = async (users, type, message, data, eventName) => {
    for (const user of users) {
      await createNotification(user._id, type, message, data, io);
    }
  };

  const notificationHandlers = [
    {
      event: 'orderCreated',
      type: 'new_order_from_branch',
      socketEvent: 'newOrderFromBranch',
      getMessage: (order) => `طلب جديد ${order.orderNumber} من ${order.branch?.name || 'Unknown'}`,
      getRooms: (branchId) => ['admin', 'production', `branch-${branchId}`],
    },
    {
      event: 'orderApproved',
      type: 'order_approved_for_branch',
      socketEvent: 'orderApprovedForBranch',
      getMessage: (order) => `تم اعتماد الطلب ${order.orderNumber} لـ ${order.branch?.name || 'Unknown'}`,
      getRooms: (branchId) => ['admin', 'production', `branch-${branchId}`],
    },
    {
      event: 'taskAssigned',
      type: 'new_production_assigned_to_chef',
      socketEvent: 'newProductionAssignedToChef',
      getMessage: (order) => `تم تعيين مهمة جديدة لك في الطلب ${order.orderNumber || 'Unknown'}`,
      getRooms: (data, order) => ['admin', 'production', `chef-${data.chefId}`, `branch-${order.branch?._id || data.branchId}`],
    },
    {
      event: 'taskCompleted',
      type: 'order_completed_by_chefs',
      socketEvent: 'orderCompletedByChefs',
      getMessage: (order, data) => `تم إكمال مهمة (${data.productName || 'Unknown'}) في الطلب ${order.orderNumber || 'Unknown'}`,
      getRooms: (data, order) => ['admin', 'production', `chef-${data.chefId}`, `branch-${order.branch?._id}`],
    },
    {
      event: 'branchConfirmed',
      type: 'branch_confirmed_receipt',
      socketEvent: 'branchConfirmedReceipt',
      getMessage: (order) => `تم تأكيد استلام الطلب ${order.orderNumber} بواسطة ${order.branch?.name || 'Unknown'}`,
      getRooms: (branchId) => ['admin', 'production', `branch-${branchId}`],
    },
    {
      event: 'orderInTransit',
      type: 'order_in_transit_to_branch',
      socketEvent: 'orderInTransitToBranch',
      getMessage: (order) => `الطلب ${order.orderNumber} في طريقه إلى ${order.branch?.name || 'Unknown'}`,
      getRooms: (branchId) => ['admin', 'production', `branch-${branchId}`],
    },
    {
      event: 'orderDelivered',
      type: 'order_delivered',
      socketEvent: 'orderDelivered',
      getMessage: (order) => `تم تسليم الطلب ${order.orderNumber} إلى ${order.branch?.name || 'Unknown'}`,
      getRooms: (branchId) => ['admin', 'production', `branch-${branchId}`],
    },
    {
      event: 'returnStatusUpdated',
      type: 'return_status_updated',
      socketEvent: 'returnStatusUpdated',
      getMessage: (order, data) => `تم ${data.status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${order.orderNumber || 'Unknown'}`,
      getRooms: (branchId) => ['admin', 'production', `branch-${branchId}`],
    },
    {
      event: 'missingAssignments',
      type: 'missing_assignments',
      socketEvent: 'missingAssignments',
      getMessage: (order) => `الطلب ${order.orderNumber} يحتاج إلى تعيينات إضافية`,
      getRooms: (branchId) => ['admin', 'production', `branch-${branchId}`],
    },
  ];

  for (const handler of notificationHandlers) {
    socket.on(handler.event, async (data) => {
      const { orderId, branchId } = data;
      const order = await Order.findById(orderId).populate('branch', 'name').lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found for ${handler.event}: ${orderId}`);
        return;
      }
      const eventData = {
        _id: `${orderId}-${handler.event}-${Date.now()}`,
        type: handler.type,
        message: handler.getMessage(order, data),
        data: { orderId, branchId, eventId: `${orderId}-${handler.type}`, ...data },
        read: false,
        createdAt: new Date().toISOString(),
        sound: `https://eljoodia-client.vercel.app/sounds/${handler.type.split('_').join('')}.mp3`,
        soundType: handler.type.split('_').join(''),
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };
      const rooms = handler.getRooms(data, order);
      emitToRooms(new Set(rooms), handler.socketEvent, eventData);
      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = branchId ? await User.find({ role: 'branch', branch: branchId }).select('_id').lean() : [];
      const chefUsers = data.chefId ? await User.find({ _id: data.chefId }).select('_id').lean() : [];
      await notifyUsers([...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers], handler.type, eventData.message, eventData.data, handler.socketEvent);
    });
  }
};

module.exports = { createNotification, setupNotifications };