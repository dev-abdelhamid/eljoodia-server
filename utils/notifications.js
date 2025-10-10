const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const Return = require('../models/Return');
const ProductionAssignment = require('../models/ProductionAssignment');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = true) => {
  try {
    if (!mongoose.isValidObjectId(userId)) throw new Error('معرف المستخدم غير صالح');

    const validTypes = [
      'orderCreated', 'orderCompleted', 'taskAssigned', 'taskStarted', 'taskCompleted',
      'orderApproved', 'orderInTransit', 'orderDelivered', 'branchConfirmedReceipt',
      'returnCreated', 'returnStatusUpdated', 'missingAssignments'
    ];
    if (!validTypes.includes(type)) throw new Error(`نوع الإشعار غير صالح: ${type}`);

    if (!io || typeof io.to !== 'function') throw new Error('خطأ في تهيئة Socket.IO');

    const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}`;
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
    if (!targetUser) throw new Error('المستخدم غير موجود');

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
      : {
          _id: uuidv4(),
          user: targetUser,
          type,
          message,
          data: { ...data, eventId },
          read: false,
          createdAt: new Date(),
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
      sound: '/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
      taskAssigned: ['admin', 'production', 'chef'],
      taskStarted: ['admin', 'production', 'chef'],
      taskCompleted: ['admin', 'production', 'chef'],
      orderApproved: ['admin', 'branch', 'production'],
      orderInTransit: ['admin', 'branch', 'production'],
      orderDelivered: ['admin', 'branch', 'production'],
      branchConfirmedReceipt: ['admin', 'branch', 'production'],
      returnCreated: ['admin', 'branch', 'production'],
      returnStatusUpdated: ['admin', 'branch', 'production'],
      missingAssignments: ['admin', 'production'],
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && data.branchId) rooms.add(`branch-${data.branchId}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`);
    });

    return notification || populatedNotification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
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
        orderId,
        orderNumber,
        branchId,
        branchName: order.branch?.name,
        eventId: `${orderId}-orderCreated`,
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('orderCreated', eventData));

      const users = await User.find({
        $or: [
          { role: 'admin' },
          { role: 'production' },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id').lean();

      for (const user of users) {
        await createNotification(user._id, 'orderCreated', message, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling orderCreated:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskAssigned = async (data) => {
    const { orderId, taskId, chefId, productName, quantity, branchId, orderNumber } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `تم تعيينك لإنتاج ${productName || 'غير معروف'} في الطلب ${orderNumber || 'غير معروف'}`;
      const eventData = {
        orderId,
        taskId,
        chefId,
        productName,
        quantity,
        branchId: order.branch?._id || branchId,
        branchName: order.branch?.name,
        orderNumber,
        eventId: `${taskId}-taskAssigned`,
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('taskAssigned', eventData));

      await createNotification(chefId, 'taskAssigned', message, eventData, io, true);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling taskAssigned:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskStarted = async (data) => {
    const { orderId, taskId, chefId, productName, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `بدأ الشيف العمل على (${productName || 'غير معروف'}) في الطلب ${orderNumber || 'غير معروف'}`;
      const eventData = {
        orderId,
        taskId,
        chefId,
        productName,
        branchId: order.branch?._id || branchId,
        branchName: order.branch?.name,
        orderNumber,
        eventId: `${taskId}-taskStarted`,
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('taskStarted', eventData));

      await createNotification(chefId, 'taskStarted', message, eventData, io, true);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling taskStarted:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskCompleted = async (data) => {
    const { orderId, taskId, chefId, productName, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session);
      if (!order) return;

      const message = `تم إكمال مهمة (${productName || 'غير معروف'}) في الطلب ${orderNumber || 'غير معروف'}`;
      const eventData = {
        orderId,
        taskId,
        chefId,
        productName,
        branchId: order.branch?._id || branchId,
        branchName: order.branch?.name,
        orderNumber,
        eventId: `${taskId}-taskCompleted`,
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('taskCompleted', eventData));

      await createNotification(chefId, 'taskCompleted', message, eventData, io, true);

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
          orderId,
          orderNumber,
          branchId: order.branch?._id,
          branchName: order.branch?.name,
          eventId: `${orderId}-orderCompleted`,
        };

        const completionRooms = new Set(['admin', 'production', `branch-${order.branch?._id}`, `chef-${chefId}`]);
        completionRooms.forEach(room => io.to(room).emit('orderCompleted', completionEventData));

        const users = await User.find({
          $or: [
            { role: 'admin' },
            { role: 'production' },
            { role: 'branch', branch: order.branch?._id },
            { _id: chefId },
          ],
        }).select('_id').lean();

        for (const user of users) {
          await createNotification(user._id, 'orderCompleted', completionMessage, completionEventData, io, true);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling taskCompleted:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleReturnCreated = async (data) => {
    const { returnId, returnNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const returnDoc = await Return.findById(returnId).populate('branch', 'name').session(session).lean();
      if (!returnDoc) return;

      const message = `طلب إرجاع جديد ${returnNumber} من ${returnDoc.branch?.name || 'غير معروف'}`;
      const eventData = {
        returnId,
        returnNumber,
        branchId,
        branchName: returnDoc.branch?.name,
        eventId: `${returnId}-returnCreated`,
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('returnCreated', eventData));

      const users = await User.find({
        $or: [
          { role: 'admin' },
          { role: 'production' },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id').lean();

      for (const user of users) {
        await createNotification(user._id, 'returnCreated', message, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling returnCreated:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleReturnStatusUpdated = async (data) => {
    const { returnId, status, branchId, returnNumber } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const returnDoc = await Return.findById(returnId).populate('branch', 'name').session(session).lean();
      if (!returnDoc) return;

      const message = `طلب إرجاع ${returnNumber || `RET-${returnId.slice(-6)}`} ${status === 'approved' ? 'موافق عليه' : 'مرفوض'}`;
      const eventData = {
        returnId,
        returnNumber,
        status,
        branchId,
        branchName: returnDoc.branch?.name,
        eventId: `${returnId}-return${status === 'approved' ? 'Approved' : 'Rejected'}`,
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('returnStatusUpdated', eventData));

      const users = await User.find({
        $or: [
          { role: 'admin' },
          { role: 'production' },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id').lean();

      for (const user of users) {
        await createNotification(user._id, 'returnStatusUpdated', message, eventData, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling returnStatusUpdated:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('taskStarted', handleTaskStarted);
  socket.on('taskCompleted', handleTaskCompleted);
  socket.on('returnCreated', handleReturnCreated);
  socket.on('returnStatusUpdated', handleReturnStatusUpdated);
};

module.exports = { createNotification, setupNotifications };