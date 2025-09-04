const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const sendNotification = async (io, type, message, data, rooms, users) => {
  try {
    const eventId = `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}`;
    const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
    if (existingNotification) {
      console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
      return existingNotification;
    }

    const notification = new Notification({
      user: data.userId,
      type,
      message: message.trim(),
      data: { ...data, eventId },
      read: false,
      createdAt: new Date(),
    });

    await notification.save();

    const eventData = {
      _id: notification._id,
      type,
      message,
      data,
      read: false,
      createdAt: notification.createdAt,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    rooms.forEach(room => io.to(room).emit('newNotification', eventData));
    console.log(`[${new Date().toISOString()}] Emitted newNotification for ${type} to rooms: ${[...rooms].join(', ')}`);

    for (const userId of users) {
      await Notification.create({
        user: userId,
        type,
        message,
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
    }

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error sending notification for ${type}:`, err);
    throw err;
  }
};

const setupNotifications = (io, socket) => {
  const handleEvent = async (event, data) => {
    const { orderId, orderNumber, branchId, taskId, chefId, productName, quantity, productId, returnId, status } = data;
    const order = orderId ? await Order.findById(orderId).populate('branch', 'name').lean() : null;
    if (orderId && !order) return;

    const rooms = new Set(['admin', 'production']);
    if (branchId) rooms.add(`branch-${branchId}`);
    if (chefId) rooms.add(`chef-${chefId}`);

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = branchId ? await User.find({ role: 'branch', branch: branchId }).select('_id').lean() : [];
    const chefUsers = chefId ? await User.find({ _id: chefId }).select('_id').lean() : [];

    const users = [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers].map(u => u._id.toString());

    const eventConfigs = {
      new_order_from_branch: {
        message: `طلب جديد ${orderNumber} من ${order?.branch?.name || 'Unknown'}`,
        data: { orderId, branchId, eventId: `${orderId}-new_order_from_branch` },
      },
      order_approved_for_branch: {
        message: `تم اعتماد الطلب ${orderNumber} لـ ${order?.branch?.name || 'Unknown'}`,
        data: { orderId, branchId, eventId: `${orderId}-order_approved_for_branch` },
      },
      new_production_assigned_to_chef: {
        message: `تم تعيين مهمة جديدة لك في الطلب ${order?.orderNumber || 'Unknown'}`,
        data: { orderId, taskId, branchId, chefId, productId, productName, quantity, eventId: `${taskId}-new_production_assigned_to_chef` },
      },
      order_completed_by_chefs: {
        message: `تم إكمال مهمة (${productName || 'Unknown'}) في الطلب ${order?.orderNumber || 'Unknown'}`,
        data: { orderId, taskId, branchId: order?.branch?._id, chefId, eventId: `${taskId}-order_completed_by_chefs` },
      },
      branch_confirmed_receipt: {
        message: `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order?.branch?.name || 'Unknown'}`,
        data: { orderId, branchId, eventId: `${orderId}-branch_confirmed_receipt` },
      },
      order_in_transit_to_branch: {
        message: `الطلب ${orderNumber} في طريقه إلى ${order?.branch?.name || 'Unknown'}`,
        data: { orderId, branchId, eventId: `${orderId}-order_in_transit_to_branch` },
      },
      order_delivered: {
        message: `تم تسليم الطلب ${orderNumber} إلى ${order?.branch?.name || 'Unknown'}`,
        data: { orderId, branchId, eventId: `${orderId}-order_delivered` },
      },
      return_status_updated: {
        message: `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${order?.orderNumber || 'Unknown'}`,
        data: { returnId, orderId, branchId, eventId: `${returnId}-return_status_updated` },
      },
    };

    const config = eventConfigs[event];
    if (!config) return;

    await sendNotification(io, event, config.message, config.data, rooms, users);
  };

  socket.on('new_order_from_branch', (data) => handleEvent('new_order_from_branch', data));
  socket.on('order_approved_for_branch', (data) => handleEvent('order_approved_for_branch', data));
  socket.on('new_production_assigned_to_chef', (data) => handleEvent('new_production_assigned_to_chef', data));
  socket.on('order_completed_by_chefs', (data) => handleEvent('order_completed_by_chefs', data));
  socket.on('branch_confirmed_receipt', (data) => handleEvent('branch_confirmed_receipt', data));
  socket.on('order_in_transit_to_branch', (data) => handleEvent('order_in_transit_to_branch', data));
  socket.on('order_delivered', (data) => handleEvent('order_delivered', data));
  socket.on('return_status_updated', (data) => handleEvent('return_status_updated', data));
};

module.exports = { createNotification, setupNotifications };