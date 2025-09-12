const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, messageKey, params = {}, data = {}, io, saveToDb = true) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, messageKey, params, data, saveToDb });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'orderCreated',
      'itemCompleted',
      'orderConfirmed',
      'taskAssigned',
      'itemStatusUpdated',
      'orderStatusUpdated',
      'orderCompleted',
      'orderShipped',
      'orderDelivered',
      'returnStatusUpdated',
      'missingAssignments',
      'orderApproved',
      'orderInTransit',
      'branchConfirmedReceipt',
      'taskStarted',
      'taskCompleted',
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = data.eventId || `${data.orderId || data.taskId || 'generic'}-${type}-${userId}`;
    if (saveToDb) {
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId, user: userId }).lean();
      if (existingNotification) {
        console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
        return existingNotification;
      }
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .lean();

    if (!targetUser) {
      throw new Error('المستخدم غير موجود');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    let notification;
    if (saveToDb) {
      notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: params.message || messageKey, // الرسالة الفعلية للعرض في الخادم
        messageKey, // مفتاح الترجمة للـ Frontend
        params, // البارامترات للترجمة
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id).populate('user', 'username role branch').lean()
      : {
          _id: uuidv4(),
          user: targetUser,
          type,
          message: params.message || messageKey,
          messageKey,
          params,
          data: { ...data, eventId },
          read: false,
          createdAt: new Date(),
        };

    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      message: params.message || messageKey, // الرسالة الفعلية للـ Frontend
      messageKey: populatedNotification.messageKey, // مفتاح الترجمة
      params: populatedNotification.params, // البارامترات
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        orderId: data.orderId,
        taskId: data.taskId,
        chefId: data.chefId,
        eventId,
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
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      itemCompleted: ['admin', 'production', 'chef'],
      orderConfirmed: ['admin', 'branch'],
      taskAssigned: ['admin', 'production', 'chef'],
      itemStatusUpdated: ['admin', 'production', 'chef'],
      orderStatusUpdated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
      orderShipped: ['admin', 'branch', 'production'],
      orderDelivered: ['admin', 'branch', 'production'],
      returnStatusUpdated: ['admin', 'branch', 'production'],
      missingAssignments: ['admin', 'production'],
      orderApproved: ['admin', 'branch', 'production'],
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

const setupNotifications = (io, socket) => {
  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_created';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-orderCreated`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderCreated', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskAssigned = async (data) => {
    const { orderId, taskId, chefId, productId, productName, quantity, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const chef = await User.findById(chefId).select('username').lean();
      const messageKey = 'notifications.task_assigned';
      const params = {
        chefName: chef?.username || 'غير معروف',
        productName: productName || 'غير معروف',
        quantity: quantity || 1,
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        taskId,
        branchId: order.branch?._id || branchId,
        chefId,
        productId,
        productName,
        quantity,
        eventId: `${taskId}-taskAssigned`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...chefUsers]) {
        await createNotification(user._id, 'taskAssigned', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderConfirmed = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_confirmed';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-orderConfirmed`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderConfirmed', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order confirmed:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleItemCompleted = async (data) => {
    const { orderId, itemId, productName, quantity, branchId, chefId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.item_completed';
      const params = {
        quantity: quantity || 1,
        productName: productName || 'غير معروف',
        orderNumber: order.orderNumber || 'غير معروف',
      };

      const eventData = {
        orderId,
        itemId,
        branchId: order.branch?._id || branchId,
        chefId,
        eventId: `${itemId}-itemCompleted`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...chefUsers]) {
        await createNotification(user._id, 'itemCompleted', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling item completed:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleItemStatusUpdated = async (data) => {
    const { orderId, itemId, status, productName, quantity, branchId, chefId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.item_status_updated';
      const params = {
        quantity: quantity || 1,
        productName: productName || 'غير معروف',
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        itemId,
        status,
        branchId: order.branch?._id || branchId,
        chefId,
        eventId: `${itemId}-itemStatusUpdated`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...chefUsers]) {
        await createNotification(user._id, 'itemStatusUpdated', messageKey, params, eventData, io, true);
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
    const { orderId, status, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_status_updated';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        status,
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        status,
        eventId: `${orderId}-orderStatusUpdated`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderStatusUpdated', messageKey, params, eventData, io, true);
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
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = order.branch?._id.toString() === branchId ? 'notifications.order_completed_for_branch' : 'notifications.order_completed';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-orderCompleted`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();
      const chefUsers = await User.find({ role: 'chef', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers]) {
        await createNotification(user._id, 'orderCompleted', messageKey, params, eventData, io, true);
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
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = order.branch?._id.toString() === branchId ? 'notifications.order_shipped_for_branch' : 'notifications.order_shipped';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-orderShipped`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderShipped', messageKey, params, eventData, io, true);
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
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = order.branch?._id.toString() === branchId ? 'notifications.order_delivered_for_branch' : 'notifications.order_delivered';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-orderDelivered`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderDelivered', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order delivered:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleBranchConfirmedReceipt = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.branch_confirmed_receipt';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-branchConfirmedReceipt`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'branchConfirmedReceipt', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling branch confirmed receipt:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskStarted = async (data) => {
    const { orderId, taskId, chefId, productName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.task_started';
      const params = {
        productName: productName || 'غير معروف',
        orderNumber: order.orderNumber || 'غير معروف',
      };

      const eventData = {
        orderId,
        taskId,
        branchId: order.branch?._id,
        chefId,
        eventId: `${taskId}-taskStarted`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...chefUsers]) {
        await createNotification(user._id, 'taskStarted', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task started:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskCompleted = async (data) => {
    const { orderId, taskId, chefId, productName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session);
      if (!order) return;

      const messageKey = 'notifications.task_completed';
      const params = {
        productName: productName || 'غير معروف',
        orderNumber: order.orderNumber || 'غير معروف',
      };

      const eventData = {
        orderId,
        taskId,
        branchId: order.branch?._id,
        chefId,
        eventId: `${taskId}-taskCompleted`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...chefUsers]) {
        await createNotification(user._id, 'taskCompleted', messageKey, params, eventData, io, true);
      }

      const allTasksCompleted = order.items.every(item => item.status === 'completed');
      if (allTasksCompleted && order.status !== 'completed') {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
        });
        await order.save({ session });

        const completionMessageKey = order.branch?._id.toString() === order.branch?._id.toString() ? 'notifications.order_completed_for_branch' : 'notifications.order_completed';
        const completionParams = {
          orderNumber: order.orderNumber || 'غير معروف',
          branchName: order.branch?.name || 'غير معروف',
        };

        const completionEventData = {
          orderId,
          branchId: order.branch?._id,
          eventId: `${orderId}-orderCompleted`,
        };

        const branchUsers = await User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean();
        for (const user of [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers]) {
          await createNotification(user._id, 'orderCompleted', completionMessageKey, completionParams, completionEventData, io, true);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderApproved = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_approved_for_branch';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-orderApproved`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderApproved', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderInTransit = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.order_in_transit_to_branch';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-orderInTransit`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderInTransit', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleMissingAssignments = async (data) => {
    const { orderId, itemId, orderNumber, productName, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.missing_assignments';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        productName: productName || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        itemId,
        branchId,
        eventId: `${itemId}-missingAssignments`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers]) {
        await createNotification(user._id, 'missingAssignments', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling missing assignments:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleReturnStatusUpdated = async (data) => {
    const { orderId, returnId, status, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const messageKey = 'notifications.return_status_updated';
      const params = {
        orderNumber: order.orderNumber || 'غير معروف',
        status,
        branchName: order.branch?.name || 'غير معروف',
      };

      const eventData = {
        orderId,
        returnId,
        status,
        branchId,
        eventId: `${returnId}-returnStatusUpdated`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'returnStatusUpdated', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling return status updated:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('orderConfirmed', handleOrderConfirmed);
  socket.on('itemCompleted', handleItemCompleted);
  socket.on('itemStatusUpdated', handleItemStatusUpdated);
  socket.on('orderStatusUpdated', handleOrderStatusUpdated);
  socket.on('orderCompleted', handleOrderCompleted);
  socket.on('orderShipped', handleOrderShipped);
  socket.on('orderDelivered', handleOrderDelivered);
  socket.on('branchConfirmedReceipt', handleBranchConfirmedReceipt);
  socket.on('taskStarted', handleTaskStarted);
  socket.on('taskCompleted', handleTaskCompleted);
  socket.on('orderApproved', handleOrderApproved);
  socket.on('orderInTransit', handleOrderInTransit);
  socket.on('missingAssignments', handleMissingAssignments);
  socket.on('returnStatusUpdated', handleReturnStatusUpdated);
};

module.exports = { createNotification, setupNotifications };