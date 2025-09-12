const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = true) => {  // saveToDb=true افتراضي
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data, saveToDb });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'orderCreated', 'orderConfirmed', 'taskAssigned', 'itemStatusUpdated', 'orderStatusUpdated',
      'orderCompleted', 'orderShipped', 'orderDelivered', 'returnStatusUpdated', 'missingAssignments'
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    // eventId unique ومتسق مع Frontend
    const eventId = data.eventId || `${type}-${userId}-${Date.now()}-${uuidv4().slice(0, 8)}`;
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

    let notification;
    if (saveToDb) {
      notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: message.trim(),
        data,
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id).populate('user', 'username role branch').lean()
      : { _id: uuidv4(), user: targetUser, type, message, data, read: false, createdAt: new Date() };

    // eventData متسق مع Frontend (sound نسبي، eventId موجود)
    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      message: populatedNotification.message,
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        orderId: data.orderId,
        itemId: data.itemId,
        chefId: data.chefId,
        branchName: targetUser.branch?.name || 'غير معروف',
        orderNumber: data.orderNumber,
      },
      read: populatedNotification.read,
      createdAt: populatedNotification.createdAt.toISOString(),
      sound: '/sounds/notification.mp3',  // نسبي لـ Frontend
      vibrate: data.vibrate || [200, 100, 200],
      eventId,
    };

    // emit event name = type (متطابق مع Frontend)
    io.to(`user-${userId}`).emit(type, eventData);
    console.log(`[${new Date().toISOString()}] Notification sent via ${type} to user-${userId}`);

    // rooms حسب roles (متطابق مع Frontend)
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
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && data.branchId) rooms.add(`branch-${data.branchId}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => {
      io.to(room).emit(type, eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room ${room} via ${type}`);
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
  // handler لـ joinRoom مع missed notifications (best practice Socket.IO 2025)
  socket.on('joinRoom', async (data) => {
    const { userId, role, branchId, chefId, departmentId } = data;
    socket.join(`user-${userId}`);
    if (role === 'admin') socket.join('admin');
    if (role === 'production') socket.join('production');
    if (role === 'branch' && branchId) socket.join(`branch-${branchId}`);
    if (role === 'chef' && chefId) socket.join(`chef-${chefId}`);
    if (departmentId) socket.join(`department-${departmentId}`);

    // أرسل unread missed notifications على reconnect
    const missed = await Notification.find({ user: userId, read: false })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    missed.forEach(notif => {
      const eventData = {
        _id: notif._id,
        type: notif.type,
        message: notif.message,
        data: notif.data,
        read: notif.read,
        createdAt: notif.createdAt.toISOString(),
        eventId: notif.data.eventId,
        sound: '/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      };
      socket.emit(notif.type, eventData);
    });
    console.log(`[${new Date().toISOString()}] Sent ${missed.length} missed notifications to user ${userId} on join`);
  });

  // handlers للـ events الرئيسية (استدعي createNotification مع saveToDb=true)
  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `طلب جديد ${orderNumber} من ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        orderId, orderNumber, branchId, branchName: order.branch?.name,
        eventId: `${orderId}-orderCreated`,
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderCreated', message, eventData, io, true);
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
    const { orderId, items, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      for (const item of items) {
        const message = `تم تعيينك لإنتاج ${item.productName || 'غير معروف'} في الطلب ${orderNumber}`;
        const eventData = {
          orderId, orderNumber, branchId: order.branch?._id || branchId,
          items: [item], eventId: `${item.itemId}-taskAssigned`,
        };
        await createNotification(item.assignedTo._id, 'taskAssigned', message, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
    } finally {
      session.endSession();
    }
  };

  // أضف handlers للباقي زي orderStatusUpdated, orderCompleted, إلخ بنفس الطريقة
  const handleOrderStatusUpdated = async (data) => {
    const { orderId, status, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `تم تحديث حالة الطلب ${orderNumber} إلى ${status}`;
      const eventData = { orderId, status, orderNumber, branchId, branchName: order.branch?.name, eventId: `${orderId}-orderStatusUpdated-${status}` };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderStatusUpdated', message, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order status updated:`, err);
    } finally {
      session.endSession();
    }
  };

  // ربط handlers (كل events من Frontend)
  socket.on('orderCreated', handleOrderCreated);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('orderStatusUpdated', handleOrderStatusUpdated);
  socket.on('itemStatusUpdated', handleOrderStatusUpdated);  // يمكن دمج
  socket.on('orderConfirmed', handleOrderStatusUpdated);  // map to orderStatusUpdated
  socket.on('orderCompleted', handleOrderStatusUpdated);
  socket.on('orderShipped', handleOrderStatusUpdated);
  socket.on('orderDelivered', handleOrderStatusUpdated);
  socket.on('returnStatusUpdated', handleOrderStatusUpdated);
  socket.on('missingAssignments', handleOrderStatusUpdated);

  // cleanup على disconnect (best practice)
  socket.on('disconnect', () => {
    console.log(`[${new Date().toISOString()}] Socket disconnected: ${socket.id}`);
    socket.rooms.forEach(room => socket.leave(room));
  });
};

module.exports = { createNotification, setupNotifications };