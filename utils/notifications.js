const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const { emitSocketEvent, notifyUsers } = require('../utils/helpers');

/**
 * Creates a notification for a user and emits it via Socket.IO
 * @param {string} userId - The ID of the user to notify
 * @param {string} type - The type of notification
 * @param {string} message - The notification message
 * @param {object} data - Additional data for the notification
 * @param {object} io - Socket.IO instance
 * @param {boolean} saveToDb - Whether to save the notification to the database
 * @returns {Promise<object>} The created notification
 */
const createNotification = async (userId, type, message, data = {}, io, saveToDb = false) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data, saveToDb });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'orderCreated',
      'orderCompleted',
      'taskAssigned',
      'orderApproved',
      'orderInTransit',
      'orderDelivered',
      'branchConfirmedReceipt',
      'taskStarted',
      'taskCompleted'
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = data.eventId || `${data.orderId || data.taskId || 'generic'}-${type}-${userId}-${Date.now()}`;
    if (saveToDb) {
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).session(session).lean();
      if (existingNotification) {
        console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
        await session.abortTransaction();
        return existingNotification;
      }
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .session(session)
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
        message: message.trim(),
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save({ session });
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id)
          .populate('user', 'username role branch')
          .session(session)
          .lean()
      : { _id: uuidv4(), user: targetUser, type, message, data: { ...data, eventId }, read: false, createdAt: new Date() };

    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      message: populatedNotification.message,
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        orderId: data.orderId,
        taskId: data.taskId,
        chefId: data.chefId,
      },
      read: populatedNotification.read,
      user: {
        _id: targetUser._id,
        username: targetUser.username,
        role: targetUser.role,
        branch: targetUser.branch || null,
      },
      createdAt: populatedNotification.createdAt,
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
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && (data.branchId || targetUser.branch?._id)) rooms.add(`branch-${data.branchId || targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    await emitSocketEvent(io, rooms, 'newNotification', eventData);
    await session.commitTransaction();
    return notification || populatedNotification;
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating notification:`, { message: err.message, userId, type, data });
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Sets up Socket.IO event listeners for notifications
 * @param {object} io - Socket.IO instance
 * @param {object} socket - Socket.IO socket instance
 */
const setupNotifications = (io, socket) => {
  /**
   * Handles order created event
   * @param {object} data - Event data containing orderId, orderNumber, branchId
   */
  const handleOrderCreated = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `طلب جديد ${orderNumber} من ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'orderCreated',
        message,
        data: { orderId, branchId, orderNumber, eventId: `${orderId}-orderCreated` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const [adminUsers, productionUsers, branchUsers] = await Promise.all([
        User.find({ role: 'admin' }).select('_id').lean(),
        User.find({ role: 'production' }).select('_id').lean(),
        User.find({ role: 'branch', branch: branchId }).select('_id').lean(),
      ]);

      await notifyUsers(io, [...adminUsers, ...productionUsers, ...branchUsers], 'orderCreated', message, eventData.data, true);
      await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'newNotification', eventData);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  /**
   * Handles task assigned event
   * @param {object} data - Event data containing orderId, taskId, chefId, productId, productName, quantity, branchId
   */
  const handleTaskAssigned = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, taskId, chefId, productId, productName, quantity, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId) || !mongoose.isValidObjectId(chefId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرفات الطلب، المهمة، الشيف، أو الفرع غير صالحة');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم تعيينك لإنتاج ${productName || 'غير معروف'} في الطلب ${order.orderNumber || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-taskAssigned-${Date.now()}`,
        type: 'taskAssigned',
        message,
        data: { orderId, taskId, branchId: order.branch?._id || branchId, chefId, productId, productName, quantity, eventId: `${taskId}-taskAssigned` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      await notifyUsers(io, [{ _id: chefId }], 'taskAssigned', message, eventData.data, false);
      await emitSocketEvent(io, ['admin', 'production', `chef-${chefId}`, `branch-${branchId}`], 'newNotification', eventData);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  /**
   * Handles order approved event
   * @param {object} data - Event data containing orderId, orderNumber, branchId
   */
  const handleOrderApproved = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم اعتماد الطلب ${orderNumber} من ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderApproved-${Date.now()}`,
        type: 'orderApproved',
        message,
        data: { orderId, branchId, orderNumber, eventId: `${orderId}-orderApproved` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const [adminUsers, productionUsers, branchUsers] = await Promise.all([
        User.find({ role: 'admin' }).select('_id').lean(),
        User.find({ role: 'production' }).select('_id').lean(),
        User.find({ role: 'branch', branch: branchId }).select('_id').lean(),
      ]);

      await notifyUsers(io, [...adminUsers, ...productionUsers, ...branchUsers], 'orderApproved', message, eventData.data, false);
      await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'newNotification', eventData);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  /**
   * Handles order in transit event
   * @param {object} data - Event data containing orderId, orderNumber, branchId
   */
  const handleOrderInTransit = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderInTransit-${Date.now()}`,
        type: 'orderInTransit',
        message,
        data: { orderId, branchId, orderNumber, eventId: `${orderId}-orderInTransit` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const [adminUsers, productionUsers, branchUsers] = await Promise.all([
        User.find({ role: 'admin' }).select('_id').lean(),
        User.find({ role: 'production' }).select('_id').lean(),
        User.find({ role: 'branch', branch: branchId }).select('_id').lean(),
      ]);

      await notifyUsers(io, [...adminUsers, ...productionUsers, ...branchUsers], 'orderInTransit', message, eventData.data, false);
      await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'newNotification', eventData);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  /**
   * Handles order delivered event
   * @param {object} data - Event data containing orderId, orderNumber, branchId
   */
  const handleOrderDelivered = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم توصيل الطلب ${orderNumber} إلى ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderDelivered-${Date.now()}`,
        type: 'orderDelivered',
        message,
        data: { orderId, branchId, orderNumber, eventId: `${orderId}-orderDelivered` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const [adminUsers, productionUsers, branchUsers] = await Promise.all([
        User.find({ role: 'admin' }).select('_id').lean(),
        User.find({ role: 'production' }).select('_id').lean(),
        User.find({ role: 'branch', branch: branchId }).select('_id').lean(),
      ]);

      await notifyUsers(io, [...adminUsers, ...productionUsers, ...branchUsers], 'orderDelivered', message, eventData.data, false);
      await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'newNotification', eventData);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order delivered:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  /**
   * Handles branch confirmed receipt event
   * @param {object} data - Event data containing orderId, orderNumber, branchId
   */
  const handleBranchConfirmedReceipt = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-branchConfirmedReceipt-${Date.now()}`,
        type: 'branchConfirmedReceipt',
        message,
        data: { orderId, branchId, orderNumber, eventId: `${orderId}-branchConfirmedReceipt` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const [adminUsers, productionUsers, branchUsers] = await Promise.all([
        User.find({ role: 'admin' }).select('_id').lean(),
        User.find({ role: 'production' }).select('_id').lean(),
        User.find({ role: 'branch', branch: branchId }).select('_id').lean(),
      ]);

      await notifyUsers(io, [...adminUsers, ...productionUsers, ...branchUsers], 'branchConfirmedReceipt', message, eventData.data, false);
      await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'newNotification', eventData);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling branch confirmed receipt:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  /**
   * Handles task started event
   * @param {object} data - Event data containing orderId, taskId, chefId, productName
   */
  const handleTaskStarted = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, taskId, chefId, productName } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId) || !mongoose.isValidObjectId(chefId)) {
        throw new Error('معرفات الطلب، المهمة، أو الشيف غير صالحة');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `بدأ الشيف العمل على (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-taskStarted-${Date.now()}`,
        type: 'taskStarted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, productName, eventId: `${taskId}-taskStarted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      await notifyUsers(io, [{ _id: chefId }], 'taskStarted', message, eventData.data, false);
      await emitSocketEvent(io, ['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id}`], 'newNotification', eventData);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task started:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  /**
   * Handles task completed event
   * @param {object} data - Event data containing orderId, taskId, chefId, productName
   */
  const handleTaskCompleted = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, taskId, chefId, productName } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId) || !mongoose.isValidObjectId(chefId)) {
        throw new Error('معرفات الطلب، المهمة، أو الشيف غير صالحة');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session);
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم إكمال مهمة (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-taskCompleted-${Date.now()}`,
        type: 'taskCompleted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, productName, eventId: `${taskId}-taskCompleted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      await notifyUsers(io, [{ _id: chefId }], 'taskCompleted', message, eventData.data, false);
      await emitSocketEvent(io, ['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id}`], 'newNotification', eventData);

      const allTasks = await mongoose.model('ProductionAssignment').find({ order: orderId }).session(session).lean();
      const isOrderCompleted = allTasks.every(task => task.status === 'completed');

      if (isOrderCompleted) {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
          notes: 'تم إكمال جميع المهام',
        });
        await order.save({ session });

        const completionMessage = `تم اكتمال الطلب ${order.orderNumber} بالكامل`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: completionMessage,
          data: { orderId, branchId: order.branch?._id, orderNumber: order.orderNumber, eventId: `${orderId}-orderCompleted` },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const [adminUsers, productionUsers, branchUsers, chefUsers] = await Promise.all([
          User.find({ role: 'admin' }).select('_id').lean(),
          User.find({ role: 'production' }).select('_id').lean(),
          User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean(),
          User.find({ _id: chefId }).select('_id').lean(),
        ]);

        await notifyUsers(io, [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers], 'orderCompleted', completionMessage, completionEventData.data, true);
        await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`, `chef-${chefId}`], 'newNotification', completionEventData);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, { message: err.message });
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('orderApproved', handleOrderApproved);
  socket.on('orderInTransit', handleOrderInTransit);
  socket.on('orderDelivered', handleOrderDelivered);
  socket.on('branchConfirmedReceipt', handleBranchConfirmedReceipt);
  socket.on('taskStarted', handleTaskStarted);
  socket.on('taskCompleted', handleTaskCompleted);
};

module.exports = { createNotification, setupNotifications };