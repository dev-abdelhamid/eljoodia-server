const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { check, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const Order = require('../models/Order');

const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'طلبات الإشعارات كثيرة جدًا، حاول مرة أخرى لاحقًا',
});

router.post(
  '/',
  [
    auth,
    authorize(['admin', 'branch', 'production', 'chef']),
    notificationLimiter,
    check('type').isIn(['success', 'error', 'info', 'warning']).withMessage('نوع الإشعار غير صالح'),
    check('eventType')
      .optional()
      .isIn([
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
      ])
      .withMessage('نوع الحدث غير صالح'),
    check('messageKey').notEmpty().withMessage('مفتاح الرسالة مطلوب'),
    check('params').optional().isObject().withMessage('البارامز يجب أن تكون كائنًا'),
    check('data').optional().isObject().withMessage('البيانات يجب أن تكون كائنًا'),
    check('userId').isMongoId().withMessage('معرف المستخدم غير صالح'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Validation errors in POST /notifications:`, errors.array());
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { userId, type, eventType, messageKey, params = {}, data = {} } = req.body;
      console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, {
        type,
        eventType,
        messageKey,
        params,
        data,
      });

      const notification = await createNotification(userId, type, eventType, messageKey, params, data, req.app.get('io'), true);
      res.status(201).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in POST /notifications:`, {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get('/', [auth, notificationLimiter], async (req, res) => {
  try {
    const { page = 1, limit = 100, userId, branchId, chefId, departmentId } = req.query;
    const query = {};

    if (userId) query.user = userId;
    if (branchId) query['data.branchId'] = branchId;
    if (chefId) query['data.chefId'] = chefId;
    if (departmentId) query['data.departmentId'] = departmentId;

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('user', 'username role branch')
      .lean();

    const total = await Notification.countDocuments(query);

    res.json({
      success: true,
      data: notifications.map((n) => ({
        _id: n._id,
        type: n.type,
        eventType: n.eventType,
        messageKey: n.messageKey,
        params: n.params,
        message: n.message,
        data: n.data,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in GET /notifications:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/user/:userId', [auth, notificationLimiter], async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 100 } = req.query;

    if (!mongoose.isValidObjectId(userId)) {
      console.error(`[${new Date().toISOString()}] Invalid user ID: ${userId}`);
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    const notifications = await Notification.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('user', 'username role branch')
      .lean();

    const total = await Notification.countDocuments({ user: userId });

    res.json({
      success: true,
      data: notifications.map((n) => ({
        _id: n._id,
        type: n.type,
        eventType: n.eventType,
        messageKey: n.messageKey,
        params: n.params,
        message: n.message,
        data: n.data,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in GET /notifications/user/:userId:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.put('/:id/read', [auth, notificationLimiter], async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الإشعار غير صالح' });
    }

    const notification = await Notification.findByIdAndUpdate(id, { read: true }, { new: true }).lean();
    if (!notification) {
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }

    req.app.get('io').to(`user-${notification.user}`).emit('notificationRead', { notificationId: id });
    res.json({ success: true, data: notification });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PUT /notifications/:id/read:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.put('/mark-all-read', [auth, notificationLimiter], async (req, res) => {
  try {
    const { userId } = req.body;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    await Notification.updateMany({ user: userId, read: false }, { read: true });
    req.app.get('io').to(`user-${userId}`).emit('allNotificationsRead', { userId });
    res.json({ success: true, message: 'تم وضع علامة مقروء على جميع الإشعارات' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PUT /notifications/mark-all-read:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.delete('/clear', [auth, notificationLimiter], async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user.id });
    req.app.get('io').to(`user-${req.user.id}`).emit('notificationsCleared', { userId: req.user.id });
    res.json({ success: true, message: 'تم مسح جميع الإشعارات' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in DELETE /notifications/clear:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

const createNotification = async (userId, type, eventType, messageKey, params = {}, data = {}, io, saveToDb = true) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, {
      type,
      eventType,
      messageKey,
      params,
      data,
      saveToDb,
    });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = ['success', 'error', 'info', 'warning'];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    const validEventTypes = [
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
    if (eventType && !validEventTypes.includes(eventType)) {
      throw new Error(`نوع الحدث غير صالح: ${eventType}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${eventType || type}-${userId}`;
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
        eventType: eventType || type,
        message: params.message || messageKey,
        messageKey,
        params,
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
          eventType: eventType || type,
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
      eventType: populatedNotification.eventType,
      message: params.message || messageKey,
      messageKey: populatedNotification.messageKey,
      params: populatedNotification.params,
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
    }[eventType || type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && (data.branchId || targetUser.branch?._id)) rooms.add(`branch-${data.branchId || targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach((room) => {
      io.to(room).emit(eventType || type, eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
    });

    return notification || populatedNotification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, {
      message: err.message,
      stack: err.stack,
      userId,
      type,
      eventType,
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
        await createNotification(user._id, 'success', 'orderCreated', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'taskAssigned', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'orderConfirmed', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order confirmed:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'itemCompleted', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling item completed:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'info', 'itemStatusUpdated', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling item status updated:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'info', 'orderStatusUpdated', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order status updated:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'orderCompleted', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order completed:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'orderShipped', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order shipped:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'orderDelivered', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order delivered:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'branchConfirmedReceipt', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling branch confirmed receipt:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'info', 'taskStarted', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task started:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'taskCompleted', messageKey, params, eventData, io, true);
      }

      const allTasksCompleted = order.items.every((item) => item.status === 'completed');
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
          await createNotification(user._id, 'success', 'orderCompleted', completionMessageKey, completionParams, completionEventData, io, true);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'success', 'orderApproved', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'info', 'orderInTransit', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'warning', 'missingAssignments', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling missing assignments:`, {
        error: err.message,
        stack: err.stack,
      });
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
        await createNotification(user._id, 'info', 'returnStatusUpdated', messageKey, params, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling return status updated:`, {
        error: err.message,
        stack: err.stack,
      });
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

module.exports = { router, createNotification, setupNotifications };