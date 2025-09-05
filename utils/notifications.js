// File: utils/notifications.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const Branch = require('../models/Branch');

const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    if (!mongoose.isValidObjectId(userId)) throw new Error('Invalid user ID');

    const validTypes = [
      'new_order_from_branch', 'order_approved_for_branch', 'task_assigned',
      'order_completed_by_chefs', 'order_in_transit_to_branch', 'branch_confirmed_receipt',
      'task_completed', 'order_status_updated'
    ];
    if (!validTypes.includes(type)) throw new Error('Invalid notification type');

    const eventId = `${data.orderId || data.taskId || uuidv4()}-${type}`;
    const existing = await Notification.findOne({ user: userId, 'data.eventId': eventId });
    if (existing) {
      console.warn(`[${new Date().toISOString()}] Duplicate notification skipped: ${eventId}`);
      return existing;
    }

    const user = await User.findById(userId).select('username role branch department').populate('branch', 'name');
    if (!user) throw new Error('User not found');

    const notification = new Notification({
      _id: uuidv4(),
      user: userId,
      type,
      message,
      data: { ...data, eventId },
      read: false
    });
    await notification.save();

    const baseUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    const soundMap = {
      new_order_from_branch: 'new_order',
      order_approved_for_branch: 'order_approved',
      task_assigned: 'task_assigned',
      order_completed_by_chefs: 'task_completed',
      order_in_transit_to_branch: 'order_in_transit',
      branch_confirmed_receipt: 'order_delivered',
      task_completed: 'task_completed',
      order_status_updated: 'order_status_updated'
    };
    const soundType = soundMap[type] || 'default';

    const eventData = {
      _id: notification._id,
      type: notification.type,
      message: notification.message,
      data: notification.data,
      read: false,
      user: { _id: user._id, username: user.username, role: user.role, branch: user.branch },
      createdAt: notification.createdAt,
      sound: `${baseUrl}/sounds/${soundType}.mp3`,
      vibrate: [200, 100, 200]
    };

    const rooms = [`user-${userId}`];
    if (user.role === 'admin') rooms.push('admin');
    if (user.role === 'production') rooms.push('production');
    if (user.role === 'branch' && user.branch) rooms.push(`branch-${user.branch._id}`);
    if (user.role === 'chef' && data.chefId) rooms.push(`chef-${data.chefId}`);
    if (data.departmentId) rooms.push(`department-${data.departmentId}`);

    await emitSocketEvent(io, rooms, 'newNotification', eventData);

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err.message);
    throw err;
  }
};

const setupNotifications = (io) => {
  io.on('connection', (socket) => {
    socket.on('joinRoom', ({ role, userId, chefId, branchId, departmentId }) => {
      const rooms = [`user-${userId}`];
      if (role === 'admin') rooms.push('admin');
      if (role === 'production') rooms.push('production');
      if (role === 'branch' && branchId) rooms.push(`branch-${branchId}`);
      if (role === 'chef' && chefId) rooms.push(`chef-${chefId}`);
      if (departmentId) rooms.push(`department-${departmentId}`);
      rooms.forEach(room => socket.join(room));
    });

    // Additional event handlers for workflow
    socket.on('orderCreated', async (data) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const { orderId, orderNumber, branchId } = data;
        const order = await Order.findById(orderId).populate('branch', 'name').session(session);
        if (!order) throw new Error('Order not found');

        const message = `طلب جديد ${orderNumber} من ${order.branch.name || 'غير معروف'}`;
        const eventData = { orderId, orderNumber, branchId };

        const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id');
        await notifyUsers(io, users, 'new_order_from_branch', message, eventData);

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error('Error in orderCreated:', err.message);
      } finally {
        session.endSession();
      }
    });

    socket.on('orderApproved', async (data) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const { orderId, orderNumber, branchId } = data;
        const order = await Order.findById(orderId).populate('branch', 'name').session(session);
        if (!order) throw new Error('Order not found');

        const message = `تم اعتماد الطلب ${orderNumber} لـ ${order.branch.name || 'غير معروف'}`;
        const eventData = { orderId, orderNumber, branchId };

        const users = await User.find({ role: 'branch', branch: branchId }).select('_id');
        await notifyUsers(io, users, 'order_approved_for_branch', message, eventData);

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error('Error in orderApproved:', err.message);
      } finally {
        session.endSession();
      }
    });

    socket.on('orderShipped', async (data) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const { orderId, orderNumber, branchId } = data;
        const order = await Order.findById(orderId).populate('branch', 'name').session(session);
        if (!order) throw new Error('Order not found');

        const message = `الطلب ${orderNumber} في الطريق إلى ${order.branch.name || 'غير معروف'}`;
        const eventData = { orderId, orderNumber, branchId };

        const users = await User.find({ role: 'branch', branch: branchId }).select('_id');
        await notifyUsers(io, users, 'order_in_transit_to_branch', message, eventData);

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error('Error in orderShipped:', err.message);
      } finally {
        session.endSession();
      }
    });

    socket.on('receiptConfirmed', async (data) => {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const { orderId, orderNumber, branchId } = data;
        const order = await Order.findById(orderId).populate('branch', 'name').session(session);
        if (!order) throw new Error('Order not found');

        const message = `تم تأكيد استلام الطلب ${orderNumber} من ${order.branch.name || 'غير معروف'}`;
        const eventData = { orderId, orderNumber, branchId };

        const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id');
        await notifyUsers(io, users, 'branch_confirmed_receipt', message, eventData);

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error('Error in receiptConfirmed:', err.message);
      } finally {
        session.endSession();
      }
    });
  });
};

module.exports = { createNotification, setupNotifications };