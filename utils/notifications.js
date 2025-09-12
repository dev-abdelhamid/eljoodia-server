const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, displayType, messageKey, params = {}, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, displayType, messageKey, params, data });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'orderCreated', 'orderConfirmed', 'taskAssigned', 'itemStatusUpdated',
      'orderStatusUpdated', 'orderCompleted', 'orderShipped', 'orderDelivered',
      'returnStatusUpdated', 'missingAssignments', 'orderApproved', 'orderInTransit',
      'branchConfirmedReceipt', 'taskStarted', 'taskCompleted'
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    const validDisplayTypes = ['success', 'info', 'warning', 'error'];
    if (!validDisplayTypes.includes(displayType)) {
      throw new Error(`نوع العرض غير صالح: ${displayType}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}`;
    const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
    if (existingNotification) {
      console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
      return existingNotification;
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .lean();

    if (!targetUser) {
      throw new Error('المستخدم غير موجود');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    const notification = new Notification({
      _id: uuidv4(),
      user: userId,
      type,
      displayType,
      messageKey,
      params,
      data: { ...data, eventId },
      read: false,
      createdAt: new Date(),
    });
    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .populate('user', 'username role branch')
      .lean();

    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      displayType: populatedNotification.displayType,
      messageKey: populatedNotification.messageKey,
      params: populatedNotification.params,
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
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
      createdAt: populatedNotification.createdAt.toISOString(),
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: type === 'missingAssignments' ? [300, 100, 300] : [200, 100, 200],
    };

    let frontendEventName = type;
    if (type === 'orderApproved') frontendEventName = 'orderConfirmed';
    if (type === 'orderInTransit') frontendEventName = 'orderShipped';
    if (type === 'taskCompleted') frontendEventName = 'itemStatusUpdated';
    if (type === 'branchConfirmedReceipt') frontendEventName = 'orderDelivered';

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      orderConfirmed: ['admin', 'branch'],
      taskAssigned: ['admin', 'production', 'chef'],
      itemStatusUpdated: ['admin', 'production', 'chef'],
      orderStatusUpdated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
      orderShipped: ['admin', 'branch', 'production'],
      orderDelivered: ['admin', 'branch', 'production'],
      returnStatusUpdated: ['admin', 'branch', 'production'],
      missingAssignments: ['admin', 'production'],
      orderApproved: ['admin', 'branch'],
      orderInTransit: ['admin', 'branch', 'production'],
      branchConfirmedReceipt: ['admin', 'branch', 'production'],
      taskStarted: ['admin', 'production', 'chef'],
      taskCompleted: ['admin', 'production', 'chef'],
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && (data.branchId || targetUser.branch?._id)) rooms.add(`branch-${data.branchId || targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => {
      io.to(room).emit(frontendEventName, eventData);
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
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const messageKey = 'notifications.order_created';
      const params = {
        orderNumber,
        branchName: order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        orderNumber,
        branchId,
        branchName: order.branch?.name || 'غير معروف',
        eventId: `${orderId}-orderCreated`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderCreated', 'success', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderConfirmed = async (data) => {
    const { orderId, orderNumber, branchId, branchName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_confirmed';
      const params = {
        orderNumber,
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        orderNumber,
        branchId,
        branchName: branchName || order.branch?.name || 'غير معروف',
        eventId: `${orderId}-orderConfirmed`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderConfirmed', 'success', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order confirmed:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskAssigned = async (data) => {
    const { orderId, orderNumber, branchId, branchName, items } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order || !Array.isArray(items)) return;

      const messageKey = 'notifications.task_assigned_to_chef';
      for (const item of items) {
        if (!item.itemId || !item.productName || !item.quantity || !item.assignedTo?._id) continue;
        const params = {
          chefName: item.assignedTo.username || 'غير معروف',
          productName: item.productName,
          quantity: item.quantity,
          orderNumber,
          branchName: branchName || order.branch?.name || 'غير معروف',
        };
        const eventData = {
          orderId,
          itemId: item.itemId,
          chefId: item.assignedTo._id,
          orderNumber,
          branchName: branchName || order.branch?.name || 'غير معروف',
          eventId: `${orderId}-taskAssigned-${item.itemId}`,
        };

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        const chefUser = await User.findById(item.assignedTo._id).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers, ...(chefUser ? [chefUser] : [])]) {
          await createNotification(user._id, 'taskAssigned', 'info', messageKey, params, eventData, io);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleItemStatusUpdated = async (data) => {
    const { orderId, itemId, status, orderNumber, branchName, chefId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const item = order.items.find(i => i._id.toString() === itemId);
      if (!item) return;

      const messageKey = 'notifications.order_completed';
      const params = {
        orderNumber,
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        itemId,
        status,
        orderNumber,
        branchName: branchName || order.branch?.name || 'غير معروف',
        chefId,
        eventId: `${orderId}-itemStatusUpdated-${itemId}`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUser = chefId ? await User.findById(chefId).select('_id').lean() : null;

      for (const user of [...adminUsers, ...productionUsers, ...(chefUser ? [chefUser] : [])]) {
        await createNotification(user._id, 'itemStatusUpdated', 'info', messageKey, params, eventData, io);
      }

      const allItemsCompleted = order.items.every(i => i.status === 'completed');
      if (allItemsCompleted && order.status !== 'completed') {
        const completedMessageKey = 'notifications.order_completed';
        const completedEventData = {
          orderId,
          orderNumber,
          branchName: branchName || order.branch?.name || 'غير معروف',
          eventId: `${orderId}-orderCompleted`,
        };

        for (const user of [...adminUsers, ...productionUsers, ...(chefUser ? [chefUser] : []), ...(await User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean())]) {
          await createNotification(user._id, 'orderCompleted', 'success', completedMessageKey, params, completedEventData, io);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling item status updated:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderStatusUpdated = async (data) => {
    const { orderId, status, orderNumber, branchId, branchName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_status_updated';
      const params = {
        orderNumber,
        status: `order_status.${status}`,
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        status,
        orderNumber,
        branchId,
        branchName: branchName || order.branch?.name || 'غير معروف',
        eventId: `${orderId}-orderStatusUpdated`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderStatusUpdated', 'info', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order status updated:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderCompleted = async (data) => {
    const { orderId, orderNumber, branchId, branchName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_completed';
      const params = {
        orderNumber,
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        orderNumber,
        branchId,
        branchName: branchName || order.branch?.name || 'غير معروف',
        eventId: `${orderId}-orderCompleted`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();
      const chefUsers = await User.find({ role: 'chef', _id: { $in: order.items.map(i => i.assignedTo?._id).filter(id => id) } }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers]) {
        await createNotification(user._id, 'orderCompleted', 'success', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order completed:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderShipped = async (data) => {
    const { orderId, orderNumber, branchId, branchName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_shipped';
      const params = {
        orderNumber,
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        orderNumber,
        branchId,
        branchName: branchName || order.branch?.name || 'غير معروف',
        eventId: `${orderId}-orderShipped`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderShipped', 'success', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order shipped:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderDelivered = async (data) => {
    const { orderId, orderNumber, branchId, branchName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_delivered';
      const params = {
        orderNumber,
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        orderNumber,
        branchId,
        branchName: branchName || order.branch?.name || 'غير معروف',
        eventId: `${orderId}-orderDelivered`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderDelivered', 'success', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order delivered:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleReturnStatusUpdated = async (data) => {
    const { orderId, returnId, status, orderNumber, branchId, branchName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.return_status_updated';
      const params = {
        orderNumber,
        status: `returns.${status}`,
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        returnId,
        status,
        orderNumber,
        branchId,
        branchName: branchName || order.branch?.name || 'غير معروف',
        eventId: `${orderId}-returnStatusUpdated-${returnId}`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'returnStatusUpdated', 'info', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling return status updated:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleMissingAssignments = async (data) => {
    const { orderId, itemId, orderNumber, productName, branchId, branchName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.missing_assignments';
      const params = {
        orderNumber,
        productName: productName || 'غير معروف',
        branchName: branchName || order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        itemId,
        orderNumber,
        productName: productName || 'غير معروف',
        branchId,
        branchName: branchName || order.branch?.name || 'غير معروف',
        eventId: `${orderId}-missingAssignments-${itemId}`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers]) {
        await createNotification(user._id, 'missingAssignments', 'warning', messageKey, params, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling missing assignments:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('orderConfirmed', handleOrderConfirmed);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('itemStatusUpdated', handleItemStatusUpdated);
  socket.on('orderStatusUpdated', handleOrderStatusUpdated);
  socket.on('orderCompleted', handleOrderCompleted);
  socket.on('orderShipped', handleOrderShipped);
  socket.on('orderDelivered', handleOrderDelivered);
  socket.on('returnStatusUpdated', handleReturnStatusUpdated);
  socket.on('missingAssignments', handleMissingAssignments);
};

module.exports = { createNotification, setupNotifications };