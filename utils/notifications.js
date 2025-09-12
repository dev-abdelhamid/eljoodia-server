const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
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

    // توحيد مفاتيح الترجمة مع الـ Frontend
    const message = `notifications.${type}`; // سيتم استبدالها في الـ Frontend بـ t('notifications.<type>')
    const eventId = data.eventId || `${type}-${data.orderId || data.taskId || 'generic'}-${userId}-${Date.now()}-${uuidv4().slice(0, 8)}`;
    data.eventId = eventId;

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
        message: messageKey, // استخدام مفتاح الترجمة
        data: { ...data, eventId, ...params },
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
          message: messageKey,
          data: { ...data, eventId, ...params },
          read: false,
          createdAt: new Date(),
        };

    const eventData = {
      _id: populatedNotification._id,
      type,
      message: messageKey,
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        orderId: data.orderId,
        taskId: data.taskId,
        chefId: data.chefId,
        branchName: targetUser.branch?.name || data.branchName || 'غير معروف',
        orderNumber: data.orderNumber,
        productName: data.productName,
        quantity: data.quantity,
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
      soundType: 'notification',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
      eventId,
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
  socket.on('joinRoom', async (data) => {
    const { userId, role, branchId, chefId, departmentId } = data;
    socket.join(`user-${userId}`);
    if (role === 'admin') socket.join('admin');
    if (role === 'production') socket.join('production');
    if (role === 'branch' && branchId) socket.join(`branch-${branchId}`);
    if (role === 'chef' && chefId) socket.join(`chef-${chefId}`);
    if (departmentId) socket.join(`department-${departmentId}`);

    // إرسال الإشعارات المفقودة عند الـ reconnect
    const missed = await Notification.find({ user: userId, read: false })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    missed.forEach(notif => {
      const eventData = {
        _id: notif._id,
        type: notif.type,
        message: notif.message,
        data: notif.data,
        read: notif.read,
        createdAt: notif.createdAt.toISOString(),
        eventId: notif.data.eventId,
        sound: `${baseUrl}/sounds/notification.mp3`,
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };
      socket.emit('newNotification', eventData);
    });
    console.log(`[${new Date().toISOString()}] Sent ${missed.length} missed notifications to user ${userId} on join`);
  });

  socket.on('fetch-missed-notifications', async (data) => {
    const { userId } = data;
    const missed = await Notification.find({ user: userId, read: false })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    missed.forEach(notif => {
      const eventData = {
        _id: notif._id,
        type: notif.type,
        message: notif.message,
        data: notif.data,
        read: notif.read,
        createdAt: notif.createdAt.toISOString(),
        eventId: notif.data.eventId,
        sound: `${baseUrl}/sounds/notification.mp3`,
        soundType: 'notification',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };
      socket.emit('newNotification', eventData);
    });
    console.log(`[${new Date().toISOString()}] Sent ${missed.length} missed notifications to user ${userId}`);
  });

  // Handlers لكل الأحداث مع توحيد مفاتيح الترجمة
  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;
      const messageKey = 'notifications.order_created';
      const params = { orderNumber, branchName: order.branch?.name || 'غير معروف' };
      const eventData = { orderId, branchId, orderNumber, branchName: order.branch?.name || 'غير معروف' };
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
      const messageKey = 'notifications.task_assigned';
      const params = {
        chefName: (await User.findById(chefId).lean())?.username || 'غير معروف',
        productName: productName || 'غير معروف',
        quantity,
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
        orderNumber: order.orderNumber,
        branchName: order.branch?.name || 'غير معروف',
      };
      await createNotification(chefId, 'taskAssigned', messageKey, params, eventData, io, true);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
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
      const messageKey = 'notifications.order_approved';
      const params = { orderNumber, branchName: order.branch?.name || 'غير معروف' };
      const eventData = { orderId, branchId, orderNumber, branchName: order.branch?.name || 'غير معروف' };
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
      const messageKey = 'notifications.order_in_transit';
      const params = { orderNumber, branchName: order.branch?.name || 'غير معروف' };
      const eventData = { orderId, branchId, orderNumber, branchName: order.branch?.name || 'غير معروف' };
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

  const handleOrderDelivered = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;
      const messageKey = 'notifications.order_delivered';
      const params = { orderNumber, branchName: order.branch?.name || 'غير معروف' };
      const eventData = { orderId, branchId, orderNumber, branchName: order.branch?.name || 'غير معروف' };
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
      const params = { orderNumber, branchName: order.branch?.name || 'غير معروف' };
      const eventData = { orderId, branchId, orderNumber, branchName: order.branch?.name || 'غير معروف' };
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
        branchName: order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        taskId,
        branchId: order.branch?._id,
        chefId,
        productName,
        orderNumber: order.orderNumber,
        branchName: order.branch?.name || 'غير معروف',
      };
      await createNotification(chefId, 'taskStarted', messageKey, params, eventData, io, true);
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
        branchName: order.branch?.name || 'غير معروف',
      };
      const eventData = {
        orderId,
        taskId,
        branchId: order.branch?._id,
        chefId,
        productName,
        orderNumber: order.orderNumber,
        branchName: order.branch?.name || 'غير معروف',
      };
      await createNotification(chefId, 'taskCompleted', messageKey, params, eventData, io, true);
      const allTasksCompleted = order.items.every(item => item.status === 'completed');
      if (allTasksCompleted && order.status !== 'completed') {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
        });
        await order.save({ session });
        const completionMessageKey = 'notifications.order_completed';
        const completionParams = {
          orderNumber: order.orderNumber,
          branchName: order.branch?.name || 'غير معروف',
        };
        const completionEventData = {
          orderId,
          branchId: order.branch?._id,
          orderNumber: order.orderNumber,
          branchName: order.branch?.name || 'غير معروف',
        };
        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        const branchUsers = await User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean();
        const chefUsers = await User.find({ _id: chefId }).select('_id').lean();
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