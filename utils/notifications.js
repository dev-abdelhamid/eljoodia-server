const mongoose = require('mongoose');
const Notification = require('./notificationModel');
const User = require('./userModel');
const { v4: uuidv4 } = require('uuid');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('Invalid user ID');
    }

    const validTypes = [
      'new_order_from_branch',
      'order_approved_for_branch',
      'new_production_assigned_to_chef',
      'order_completed_by_chefs',
      'order_in_transit_to_branch',
      'branch_confirmed_receipt',
      'task_assigned',
      'order_status_updated',
    ];

    if (!validTypes.includes(type)) {
      throw new Error(`Invalid notification type: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('Socket.IO not initialized');
    }

    const eventId = `${data.orderId || data.taskId || 'generic'}-${type}-${userId}`;
    const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
    if (existingNotification) {
      console.warn(`[${new Date().toISOString()}] Duplicate notification detected: ${eventId}`);
      return existingNotification;
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .lean();

    if (!targetUser) {
      throw new Error('User not found');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://your-client-url.com';
    const soundTypeMap = {
      new_order_from_branch: 'new_order',
      order_approved_for_branch: 'order_approved',
      new_production_assigned_to_chef: 'task_assigned',
      order_completed_by_chefs: 'task_completed',
      order_in_transit_to_branch: 'order_in_transit',
      branch_confirmed_receipt: 'order_delivered',
      task_assigned: 'task_assigned',
      order_status_updated: 'order_status_updated',
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

const setupNotifications = (io) => {
  return (socket) => {
    socket.on('joinRoom', ({ role, userId, chefId, branchId, departmentId }) => {
      const rooms = new Set([`user-${userId}`]);
      if (role === 'admin') rooms.add('admin');
      if (role === 'production') rooms.add('production');
      if (role === 'branch' && branchId) rooms.add(`branch-${branchId}`);
      if (role === 'chef' && chefId) rooms.add(`chef-${chefId}`);
      if (departmentId) rooms.add(`department-${departmentId}`);
      
      rooms.forEach(room => {
        socket.join(room);
        console.log(`[${new Date().toISOString()}] Socket ${socket.id} joined room: ${room}`);
      });
    });

    const handleOrderCreated = async (data) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, orderNumber, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId).populate('branch', 'name').session(session).lean();
        if (!order) throw new Error('Order not found');

        const message = `New order ${orderNumber} from ${order.branch?.name || 'Unknown'}`;
        const eventData = { orderId, branchId, eventId: `${orderId}-new_order_from_branch` };

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers]) {
          await createNotification(user._id, 'new_order_from_branch', message, eventData, io);
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
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, orderNumber, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId).populate('branch', 'name').session(session).lean();
        if (!order) throw new Error('Order not found');

        const message = `Order ${orderNumber} approved for ${order.branch?.name || 'Unknown'}`;
        const eventData = { orderId, branchId, eventId: `${orderId}-order_approved_for_branch` };

        const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();
        for (const user of branchUsers) {
          await createNotification(user._id, 'order_approved_for_branch', message, eventData, io);
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
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, taskId, chefId, productId, productName, quantity, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId).populate('branch', 'name').session(session).lean();
        if (!order) throw new Error('Order not found');

        const message = `New task assigned for order ${order.orderNumber || 'Unknown'}: ${productName} (Qty: ${quantity})`;
        const eventData = { orderId, taskId, branchId, chefId, productId, productName, quantity, eventId: `${taskId}-new_production_assigned_to_chef` };

        await createNotification(chefId, 'new_production_assigned_to_chef', message, eventData, io);

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
      } finally {
        session.endSession();
      }
    };

    const handleTaskCompleted = async (data) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, taskId, chefId, productName } = data;
        const order = await mongoose.model('Order').findById(orderId).populate('branch', 'name').session(session);
        if (!order) throw new Error('Order not found');

        const message = `Task (${productName || 'Unknown'}) completed for order ${order.orderNumber || 'Unknown'}`;
        const eventData = { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-order_completed_by_chefs` };

        const allTasks = await mongoose.model('ProductionAssignment').find({ order: orderId }).session(session).lean();
        const isOrderCompleted = allTasks.every(task => task.status === 'completed');

        if (isOrderCompleted) {
          order.status = 'completed';
          order.statusHistory.push({
            status: 'completed',
            changedBy: chefId,
            changedAt: new Date(),
          });
          await order.save({ session });

          const completionMessage = `Order ${order.orderNumber} fully completed`;
          const completionEventData = { orderId, branchId: order.branch?._id, eventId: `${orderId}-order_completed_by_chefs` };

          const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
          const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

          for (const user of [...adminUsers, ...productionUsers]) {
            await createNotification(user._id, 'order_completed_by_chefs', completionMessage, completionEventData, io);
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
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, orderNumber, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId).populate('branch', 'name').session(session).lean();
        if (!order) throw new Error('Order not found');

        const message = `Order ${orderNumber} is in transit to ${order.branch?.name || 'Unknown'}`;
        const eventData = { orderId, branchId, eventId: `${orderId}-order_in_transit_to_branch` };

        const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();
        for (const user of branchUsers) {
          await createNotification(user._id, 'order_in_transit_to_branch', message, eventData, io);
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
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, orderNumber, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId).populate('branch', 'name').session(session).lean();
        if (!order) throw new Error('Order not found');

        const message = `Order ${orderNumber} receipt confirmed by ${order.branch?.name || 'Unknown'}`;
        const eventData = { orderId, branchId, eventId: `${orderId}-branch_confirmed_receipt` };

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers]) {
          await createNotification(user._id, 'branch_confirmed_receipt', message, eventData, io);
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
};

module.exports = { createNotification, setupNotifications };