const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = false) => {
  try {
    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'orderCreated', 'orderCompleted', 'taskAssigned', 'orderApproved', 'orderInTransit',
      'orderDelivered', 'branchConfirmedReceipt', 'taskStarted', 'taskCompleted'
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    const eventId = data.eventId || uuidv4();
    if (saveToDb) {
      const existing = await Notification.findOne({ 'data.eventId': eventId }).lean();
      if (existing) return existing;
    }

    const targetUser = await User.findById(userId).select('username role branch').populate('branch', 'name').lean();
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
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
    }

    const populatedNotification = saveToDb ? await Notification.findById(notification._id).populate('user', 'username role branch').lean() : {
      _id: uuidv4(),
      user: targetUser,
      type,
      message,
      data: { ...data, eventId },
      read: false,
      createdAt: new Date()
    };

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
      createdAt: populatedNotification.createdAt.toISOString(),
      sound: data.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: data.vibrate || [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    // غرف موحدة مع دعم production كإشراف كامل
    const roles = {
      orderCreated: ['admin', 'production', 'branch'],
      orderCompleted: ['admin', 'production', 'branch', 'chef'],
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
    if (roles.includes('production')) rooms.add('production'); // production يشرف على كل شيء
    if (roles.includes('branch') && (data.branchId || targetUser.branch?._id)) rooms.add(`branch-${data.branchId || targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    return notification || populatedNotification;
  } catch (err) {
    console.error(`Error creating notification: ${err.message}`);
    throw err;
  }
};

const handleNotificationEvent = async (io, data, type, getMessage, getRooms, usersQuery) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const order = await Order.findById(data.orderId).populate('branch', 'name').session(session).lean();
    if (!order) return;

    const message = getMessage(order, data);
    const eventData = {
      _id: `${data.orderId || data.taskId}-${type}-${Date.now()}`,
      type,
      message,
      data: { ...data, eventId: uuidv4() },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const rooms = getRooms(data, order);
    rooms.forEach(room => io.to(room).emit('newNotification', eventData));

    const users = await User.find(usersQuery).select('_id').lean();
    for (const user of users) {
      await createNotification(user._id, type, message, eventData.data, io, false);
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error handling ${type}: ${err.message}`);
  } finally {
    session.endSession();
  }
};

const setupNotifications = (io, socket) => {
  socket.on('orderCreated', (data) => handleNotificationEvent(
    io, data, 'orderCreated',
    (order) => `طلب جديد ${data.orderNumber} من ${order.branch?.name || 'غير معروف'}`,
    (data, order) => new Set(['admin', 'production', `branch-${data.branchId || order.branch?._id}`]),
    { $or: [{ role: 'admin' }, { role: 'production' }, { role: 'branch', branch: data.branchId }] }
  ));

  socket.on('taskAssigned', (data) => handleNotificationEvent(
    io, data, 'taskAssigned',
    (order) => `تم تعيينك لإنتاج ${data.productName || 'غير معروف'} في الطلب ${order.orderNumber || 'غير معروف'}`,
    (data, order) => new Set(['admin', 'production', `chef-${data.chefId}`]),
    { _id: data.chefId }
  ));

  socket.on('orderApproved', (data) => handleNotificationEvent(
    io, data, 'orderApproved',
    (order) => `تم اعتماد الطلب ${data.orderNumber} من ${order.branch?.name || 'غير معروف'}`,
    (data, order) => new Set(['admin', 'production', `branch-${data.branchId || order.branch?._id}`]),
    { $or: [{ role: 'admin' }, { role: 'production' }, { role: 'branch', branch: data.branchId }] }
  ));

  socket.on('orderInTransit', (data) => handleNotificationEvent(
    io, data, 'orderInTransit',
    (order) => `الطلب ${data.orderNumber} في طريقه إلى ${order.branch?.name || 'غير معروف'}`,
    (data, order) => new Set(['admin', 'production', `branch-${data.branchId || order.branch?._id}`]),
    { $or: [{ role: 'admin' }, { role: 'production' }, { role: 'branch', branch: data.branchId }] }
  ));

  socket.on('orderDelivered', (data) => handleNotificationEvent(
    io, data, 'orderDelivered',
    (order) => `تم توصيل الطلب ${data.orderNumber} إلى ${order.branch?.name || 'غير معروف'}`,
    (data, order) => new Set(['admin', 'production', `branch-${data.branchId || order.branch?._id}`]),
    { $or: [{ role: 'admin' }, { role: 'production' }, { role: 'branch', branch: data.branchId }] }
  ));

  socket.on('branchConfirmedReceipt', (data) => handleNotificationEvent(
    io, data, 'branchConfirmedReceipt',
    (order) => `تم تأكيد استلام الطلب ${data.orderNumber} بواسطة ${order.branch?.name || 'غير معروف'}`,
    (data, order) => new Set(['admin', 'production', `branch-${data.branchId || order.branch?._id}`]),
    { $or: [{ role: 'admin' }, { role: 'production' }, { role: 'branch', branch: data.branchId }] }
  ));

  socket.on('taskStarted', (data) => handleNotificationEvent(
    io, data, 'taskStarted',
    (order) => `بدأ الشيف العمل على (${data.productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`,
    (data, order) => new Set(['admin', 'production', `chef-${data.chefId}`]),
    { _id: data.chefId }
  ));

  socket.on('taskCompleted', async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(data.orderId).populate('branch', 'name').session(session);
      if (!order) return;

      const message = `تم إكمال مهمة (${data.productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`;
      const eventData = {
        _id: `${data.orderId}-taskCompleted-${Date.now()}`,
        type: 'taskCompleted',
        message,
        data: { ...data, eventId: uuidv4() },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${data.chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(data.chefId, 'taskCompleted', message, eventData.data, io, false);

      // تحقق من اكتمال الطلب (مع دعم production كإشراف)
      const allTasksCompleted = await ProductionAssignment.find({ order: data.orderId }).session(session).lean();
      if (allTasksCompleted.every(task => task.status === 'completed')) {
        order.status = 'completed';
        order.statusHistory.push({ status: 'completed', changedBy: data.chefId, changedAt: new Date() });
        await order.save({ session });

        const completionMessage = `تم اكتمال الطلب ${order.orderNumber} بالكامل`;
        const completionEventData = { ...eventData, type: 'orderCompleted', message: completionMessage };
        const completionRooms = new Set(['admin', 'production', `branch-${order.branch?._id}`, `chef-${data.chefId}`]);
        completionRooms.forEach(room => io.to(room).emit('newNotification', completionEventData));

        const users = await User.find({
          $or: [{ role: 'admin' }, { role: 'production' }, { role: 'branch', branch: order.branch?._id }, { _id: data.chefId }]
        }).select('_id').lean();
        for (const user of users) {
          await createNotification(user._id, 'orderCompleted', completionMessage, completionEventData.data, io, true);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`Error handling taskCompleted: ${err.message}`);
    } finally {
      session.endSession();
    }
  });
};

module.exports = { createNotification, setupNotifications };