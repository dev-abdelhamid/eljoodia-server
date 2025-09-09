const mongoose = require('mongoose');
const Notification = require('./models/Notification');

const eventHandlers = {
  orderCreated: {
    message: (data) => `طلب جديد ${data.orderNumber} تم إنشاؤه للفرع ${data.branchName}`,
    roles: ['admin', 'branch', 'production'],
    sound: '/sounds/notification.mp3',
    vibrate: [200, 100, 200],
  },
  taskAssigned: {
    message: (data) => `تم تعيينك لإنتاج ${data.productName} في الطلب ${data.orderNumber}`,
    roles: ['admin', 'production', 'chef'],
    sound: '/sounds/notification.mp3',
    vibrate: [400, 100, 400],
  },
  itemStatusUpdated: {
    message: (data) => `تم تحديث حالة العنصر ${data.productName} في الطلب ${data.orderNumber} إلى ${data.status}`,
    roles: ['admin', 'branch', 'production', 'chef'],
    sound: '/sounds/notification.mp3',
    vibrate: [200, 100, 200],
  },
  orderStatusUpdated: {
    message: (data) => `تم تحديث حالة الطلب ${data.orderNumber} إلى ${data.status}`,
    roles: ['admin', 'branch', 'production'],
    sound: '/sounds/notification.mp3',
    vibrate: [200, 100, 200],
  },
  orderCompleted: {
    message: (data) => `تم إكمال الطلب ${data.orderNumber}`,
    roles: ['admin', 'branch', 'production', 'chef'],
    sound: '/sounds/notification.mp3',
    vibrate: [400, 100, 400],
  },
  orderInTransit: {
    message: (data) => `الطلب ${data.orderNumber} في طريقه إلى الفرع ${data.branchName}`,
    roles: ['admin', 'production', 'branch'],
    sound: '/sounds/notification.mp3',
    vibrate: [400, 100, 400],
  },
  orderDelivered: {
    message: (data) => `تم توصيل الطلب ${data.orderNumber} إلى الفرع ${data.branchName}`,
    roles: ['admin', 'production', 'branch'],
    sound: '/sounds/notification.mp3',
    vibrate: [400, 100, 400],
  },
  branchConfirmedReceipt: {
    message: (data) => `تم تأكيد استلام الطلب ${data.orderNumber} بواسطة الفرع ${data.branchName}`,
    roles: ['admin', 'production', 'branch'],
    sound: '/sounds/notification.mp3',
    vibrate: [400, 100, 400],
  },
  taskStarted: {
    message: (data) => `بدأ إنتاج العنصر ${data.productName} في الطلب ${data.orderNumber}`,
    roles: ['admin', 'production', 'chef'],
    sound: '/sounds/notification.mp3',
    vibrate: [200, 100, 200],
  },
  taskCompleted: {
    message: (data) => `تم إكمال العنصر ${data.productName} في الطلب ${data.orderNumber}`,
    roles: ['admin', 'production', 'chef'],
    sound: '/sounds/notification.mp3',
    vibrate: [200, 100, 200],
  },
};

const emitSocketEvent = async (io, rooms, event, data) => {
  try {
    console.log(`[${new Date().toISOString()}] Emitting ${event} to rooms:`, rooms, data);
    io.to([...rooms]).emit(event, data);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error emitting ${event}:`, err.message);
  }
};

const notifyUsers = async (io, users, type, message, data = {}, saveToDb = false) => {
  try {
    const notification = {
      _id: new mongoose.Types.ObjectId().toString(),
      type,
      message,
      data: { ...data, eventId: data.eventId || new mongoose.Types.ObjectId().toString() },
      read: false,
      createdAt: new Date().toISOString(),
      sound: eventHandlers[type]?.sound || '/sounds/notification.mp3',
      vibrate: eventHandlers[type]?.vibrate || [200, 100, 200],
    };

    const rooms = new Set();
    users.forEach(user => {
      rooms.add(`user-${user._id}`);
      if (user.role) rooms.add(user.role);
      if (user.branchId) rooms.add(`branch-${user.branchId}`);
      if (user.role === 'chef') rooms.add(`chef-${user._id}`);
      if (user.departmentId) rooms.add(`department-${user.departmentId}`);
    });

    await emitSocketEvent(io, rooms, 'newNotification', notification);

    if (saveToDb) {
      await Notification.create({
        user: users.map(u => u._id),
        type,
        message,
        data: notification.data,
        read: false,
        createdAt: new Date(),
      });
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error notifying users:`, err.message);
  }
};

module.exports = { emitSocketEvent, notifyUsers, eventHandlers };