const mongoose = require('mongoose');
const Order = require('../models/Order');
const ProductionAssignment = require('../models/ProductionAssignment');
const { createNotification } = require('./notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const baseUrl = process.env.CLIENT_URL || 'https://eljoodia.vercel.app';
  const updatedEventData = {
    ...eventData,
    sound: `${baseUrl}/sounds/notification.mp3`,
    vibrate: eventData.vibrate || [200, 100, 200],
  };
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, updatedEventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms, eventData: updatedEventData });
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    let allCompleted = true;

    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await emitSocketEvent(io, [
          `branch-${order.branch}`,
          'production',
          'admin',
          `chef-${task.chef}`,
          `department-${item.department}`,
        ], 'newNotification', {
          type: 'order_completed_by_chefs',
          message: `تم إكمال عنصر في الطلب ${order.orderNumber}`,
          data: {
            orderId,
            itemId: item._id,
            taskId: task._id,
            status: task.status,
            productName: item.product.name,
            orderNumber: order.orderNumber,
            branchId: order.branch?.toString(),
          },
          sound: '/sounds/notification.mp3',
          vibrate: [200, 100, 200],
        });
      }
      if (task.status !== 'completed') {
        allCompleted = false;
      }
    }

    if (allCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date(),
      });
      await order.save({ session });
      await emitSocketEvent(io, [
        `branch-${order.branch}`,
        'production',
        'admin',
      ], 'newNotification', {
        type: 'order_completed_by_chefs',
        message: `تم إكمال الطلب ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?.toString(),
          completedAt: new Date().toISOString(),
        },
        sound: '/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      });
    }

    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { emitSocketEvent, syncOrderTasks };