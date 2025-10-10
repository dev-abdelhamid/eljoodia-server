
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const Return = require('../models/Return');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = false) => {
  try {
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
      'taskCompleted',
      'returnCreated',
      'returnStatusUpdated',
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = data.eventId || `${data.orderId || data.returnId || data.taskId || 'generic'}-${type}-${userId}`;
    if (saveToDb) {
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
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
        message: message.trim(),
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id).populate('user', 'username role branch').lean()
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
        returnId: data.returnId,
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
      returnCreated: ['admin', 'branch', 'production'],
      returnStatusUpdated: ['admin', 'branch', 'production'],
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

      const message = `طلب جديد ${orderNumber} من ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'orderCreated',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderCreated` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderCreated', message, eventData.data, io, true);
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

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskAssigned', message, eventData.data, io, false);

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

      const message = `تم اعتماد الطلب ${orderNumber} من ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderApproved-${Date.now()}`,
        type: 'orderApproved',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderApproved` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderApproved', message, eventData.data, io, false);
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

      const message = `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderInTransit-${Date.now()}`,
        type: 'orderInTransit',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderInTransit` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderInTransit', message, eventData.data, io, false);
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

      const message = `تم توصيل الطلب ${orderNumber} إلى ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderDelivered-${Date.now()}`,
        type: 'orderDelivered',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderDelivered` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderDelivered', message, eventData.data, io, false);
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

      const message = `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-branchConfirmedReceipt-${Date.now()}`,
        type: 'branchConfirmedReceipt',
        message,
        data: { orderId, branchId, eventId: `${orderId}-branchConfirmedReceipt` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'branchConfirmedReceipt', message, eventData.data, io, false);
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

      const message = `بدأ الشيف العمل على (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-taskStarted-${Date.now()}`,
        type: 'taskStarted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-taskStarted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskStarted', message, eventData.data, io, false);

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

      const message = `تم إكمال مهمة (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-taskCompleted-${Date.now()}`,
        type: 'taskCompleted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-taskCompleted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskCompleted', message, eventData.data, io, false);

      const allTasksCompleted = await ProductionAssignment.find({ order: orderId }).session(session).lean();
      const isOrderCompleted = allTasksCompleted.every(task => task.status === 'completed');

      if (isOrderCompleted) {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
        });
        await order.save({ session });

        const completionMessage = `تم اكتمال الطلب ${order.orderNumber} بالكامل`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: completionMessage,
          data: { orderId, branchId: order.branch?._id, eventId: `${orderId}-orderCompleted` },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const completionRooms = new Set(['admin', 'production', `branch-${order.branch?._id}`, `chef-${chefId}`]);
        completionRooms.forEach(room => io.to(room).emit('newNotification', completionEventData));

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        const branchUsers = await User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean();
        const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers]) {
          await createNotification(user._id, 'orderCompleted', completionMessage, completionEventData.data, io, true);
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



    const handleReturnCreated = async (data) => {
    const { returnId, returnNumber, branchId } = data;
    try {
      const returnDoc = await Return.findById(returnId).populate('branch', 'name').lean();
      if (!returnDoc) return;

      const message = `طلب إرجاع جديد ${returnNumber} من ${returnDoc.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${returnId}-returnCreated-${Date.now()}`,
        type: 'returnCreated',
        message,
        data: { returnId, branchId, eventId: data.eventId || `${returnId}-returnCreated` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'returnCreated', message, eventData.data, io, true);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error handling return created:`, err);
    }
  };

  const handleReturnStatusUpdated = async (data) => {
    const { returnId, status, branchId } = data;
    try {
      const returnDoc = await Return.findById(returnId).populate('branch', 'name').lean();
      if (!returnDoc) return;

      const message = `تم تحديث حالة طلب الإرجاع ${returnDoc.returnNumber || `RET-${returnId.slice(-6)}`} إلى ${status === 'approved' ? 'موافق عليه' : 'مرفوض'}`;
      const eventData = {
        _id: `${returnId}-returnStatusUpdated-${Date.now()}`,
        type: 'returnStatusUpdated',
        message,
        data: { returnId, branchId, status, eventId: data.eventId || `${returnId}-returnStatusUpdated` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'returnStatusUpdated', message, eventData.data, io, true);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error handling return status updated:`, err);
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
  socket.on('returnCreated', handleReturnCreated);
  socket.on('returnStatusUpdated', handleReturnStatusUpdated);
};

module.exports = { createNotification, setupNotifications };