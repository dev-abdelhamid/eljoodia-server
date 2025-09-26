const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const createNotification = async (notificationData, lang = 'ar') => {
  try {
    const { user, type, message, data } = notificationData;

    if (!mongoose.Types.ObjectId.isValid(user)) {
      throw new Error(lang === 'ar' ? 'معرف المستخدم غير صالح' : 'Invalid user ID');
    }

    const notification = new Notification({
      user,
      type,
      message,
      data: {
        ...data,
        eventId: data.eventId || `notif-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        timestamp: new Date().toISOString(),
      },
    });

    await notification.save();

    const io = require('../server').get('io');
    io.to(`user-${user}`).emit('notification', {
      _id: notification._id,
      user,
      type,
      message,
      data: notification.data,
      read: notification.read,
      createdAt: notification.createdAt.toISOString(),
    });

    if (data.orderId) {
      io.to(`order-${data.orderId}`).emit(data.eventId.split('-')[0], {
        orderId: data.orderId,
        orderNumber: data.orderNumber || 'N/A',
        branchId: data.branchId,
        branchName: data.branchName || 'Unknown',
        itemId: data.itemId,
        chefId: data.chefId,
        eventId: data.eventId,
        sound: data.sound || '/sounds/notification.mp3',
        vibrate: data.vibrate || [200, 100, 200],
      });
    }

    return notification;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] createNotification - Error:`, error);
    throw error;
  }
};

const setupNotifications = (io, socket) => {
  socket.on('branchConfirmedReceipt', async (data) => {
    try {
      const { orderId, lang = 'ar' } = data;
      const order = await mongoose.model('Order').findById(orderId).populate('branch').lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }
      const branchName = lang === 'ar' ? order.branch.name : (order.branch.nameEn || order.branch.name);
      const notificationData = {
        user: socket.user.id,
        type: 'success',
        message: lang === 'ar'
          ? `تم تأكيد استلام الطلب رقم ${order.orderNumber} من فرع ${branchName}`
          : `Order #${order.orderNumber} receipt confirmed by ${branchName}`,
        data: {
          orderId,
          branchId: order.branch._id,
          eventId: `branch-confirmed-${orderId}-${Date.now()}`,
          sound: '/sounds/notification.mp3',
          vibrate: [400, 100, 400],
        },
      };
      await createNotification(notificationData, lang);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] branchConfirmedReceipt - Error:`, error);
    }
  });

  socket.on('taskStarted', async (data) => {
    try {
      const { taskId, lang = 'ar' } = data;
      const task = await mongoose.model('ProductionAssignment').findById(taskId)
        .populate('order', 'orderNumber branch')
        .populate('product', 'name nameEn')
        .populate({
          path: 'order',
          populate: { path: 'branch', select: 'name nameEn' },
        })
        .lean();
      if (!task) {
        console.warn(`[${new Date().toISOString()}] Task not found: ${taskId}`);
        return;
      }
      const branchName = lang === 'ar' ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name);
      const productName = lang === 'ar' ? task.product.name : (task.product.nameEn || task.product.name);
      const notificationData = {
        user: socket.user.id,
        type: 'info',
        message: lang === 'ar'
          ? `بدأ تحضير ${productName} لطلب رقم ${task.order.orderNumber} من فرع ${branchName}`
          : `Started preparing ${productName} for order #${task.order.orderNumber} from ${branchName}`,
        data: {
          orderId: task.order._id,
          itemId: task.itemId,
          taskId,
          chefId: socket.user.chefId,
          branchId: task.order.branch,
          eventId: `task-started-${taskId}-${Date.now()}`,
          sound: '/sounds/notification.mp3',
          vibrate: [200, 100, 200],
        },
      };
      await createNotification(notificationData, lang);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] taskStarted - Error:`, error);
    }
  });

  socket.on('taskCompleted', async (data) => {
    try {
      const { taskId, lang = 'ar' } = data;
      const task = await mongoose.model('ProductionAssignment').findById(taskId)
        .populate('order', 'orderNumber branch')
        .populate('product', 'name nameEn')
        .populate({
          path: 'order',
          populate: { path: 'branch', select: 'name nameEn' },
        })
        .lean();
      if (!task) {
        console.warn(`[${new Date().toISOString()}] Task not found: ${taskId}`);
        return;
      }
      const branchName = lang === 'ar' ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name);
      const productName = lang === 'ar' ? task.product.name : (task.product.nameEn || task.product.name);
      const notificationData = {
        user: socket.user.id,
        type: 'success',
        message: lang === 'ar'
          ? `تم اكتمال تحضير ${productName} لطلب رقم ${task.order.orderNumber} من فرع ${branchName}`
          : `Completed preparing ${productName} for order #${task.order.orderNumber} from ${branchName}`,
        data: {
          orderId: task.order._id,
          itemId: task.itemId,
          taskId,
          chefId: socket.user.chefId,
          branchId: task.order.branch,
          eventId: `task-completed-${taskId}-${Date.now()}`,
          sound: '/sounds/notification.mp3',
          vibrate: [400, 100, 400],
        },
      };
      await createNotification(notificationData, lang);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] taskCompleted - Error:`, error);
    }
  });
};

module.exports = { createNotification, setupNotifications };