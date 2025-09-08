const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const ProductionAssignment = require('../models/ProductionAssignment');
const { v4: uuidv4 } = require('uuid');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'new_order_from_branch',
      'order_approved_for_branch',
      'new_production_assigned_to_chef',
      'order_completed_by_chefs',
      'order_in_transit_to_branch',
      'order_delivered',
      'branch_confirmed_receipt',
      'return_status_updated',
      'order_status_updated',
      'task_assigned',
      'task_completed',
      'missing_assignments',
    ];

    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
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
      task_assigned: 'task_assigned',
      task_completed: 'task_completed',
      missing_assignments: 'missing_assignments',
    };

    const soundType = soundTypeMap[type] || 'default';
    const notification = new Notification({
      _id: uuidv4(),
      user: userId,
      type,
      message: message.trim(),
      data: { ...data, eventId },
      read: false,
      createdAt: new Date(),
    });

    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
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

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
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
      if (!order) return;

      const message = `طلب جديد ${orderNumber} من ${order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'new_order_from_branch',
        message,
        data: { orderId, branchId, eventId: `${orderId}-new_order_from_branch` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/new_order.mp3',
        soundType: 'new_order',
        vibrate: [300, 100, 300],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = branchId ? await User.find({ role: 'branch', branch: branchId }).select('_id').lean() : [];

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'new_order_from_branch', message, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, err);
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

      const message = `تم اعتماد الطلب ${orderNumber} لـ ${order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderApproved-${Date.now()}`,
        type: 'order_approved_for_branch',
        message,
        data: { orderId, branchId, eventId: `${orderId}-order_approved_for_branch` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/order_approved.mp3',
        soundType: 'order_approved',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'order_approved_for_branch', message, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, err);
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

      const message = `تم تعيين مهمة جديدة لك في الطلب ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskAssigned-${Date.now()}`,
        type: 'new_production_assigned_to_chef',
        message,
        data: { orderId, taskId, branchId: order.branch?._id || branchId, chefId, productId, productName, quantity, eventId: `${taskId}-new_production_assigned_to_chef` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/task_assigned.mp3',
        soundType: 'task_assigned',
        vibrate: [400, 100, 400],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id || branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUsers = await User.find({ _id: chefId }).select('_id').lean();
      const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

      for (const user of [...adminUsers, ...productionUsers, ...chefUsers, ...branchUsers]) {
        await createNotification(user._id, 'new_production_assigned_to_chef', message, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
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

      const message = `تم إكمال مهمة (${productName || 'Unknown'}) في الطلب ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskCompleted-${Date.now()}`,
        type: 'order_completed_by_chefs',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-order_completed_by_chefs` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/task_completed.mp3',
        soundType: 'task_completed',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

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
      }

      const rooms = new Set(['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'order_completed_by_chefs', message, eventData.data, io);
      }

      if (isOrderCompleted) {
        const completionMessage = `تم إكمال الطلب ${order.orderNumber} بالكامل`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'order_completed_by_chefs',
          message: completionMessage,
          data: { orderId, branchId: order.branch?._id, eventId: `${orderId}-order_completed_by_chefs` },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/task_completed.mp3',
          soundType: 'task_completed',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        rooms.forEach(room => io.to(room).emit('newNotification', completionEventData));

        for (const user of [...adminUsers, ...productionUsers]) {
          await createNotification(user._id, 'order_completed_by_chefs', completionMessage, completionEventData.data, io);
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

  const handleOrderInTransit = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderInTransit-${Date.now()}`,
        type: 'order_in_transit_to_branch',
        message,
        data: { orderId, branchId, eventId: `${orderId}-order_in_transit_to_branch` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/order_in_transit.mp3',
        soundType: 'order_in_transit',
        vibrate: [300, 100, 300],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'order_in_transit_to_branch', message, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, err);
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

      const message = `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-branchConfirmed-${Date.now()}`,
        type: 'branch_confirmed_receipt',
        message,
        data: { orderId, branchId, eventId: `${orderId}-branch_confirmed_receipt` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/order_delivered.mp3',
        soundType: 'order_delivered',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'branch_confirmed_receipt', message, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order confirmed:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('orderApproved', handleOrderApproved);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('taskCompleted', handleTaskCompleted);
  socket.on('orderInTransit', handleOrderInTransit);
  socket.on('branchConfirmed', handleOrderConfirmed);
};

module.exports = { createNotification, setupNotifications };