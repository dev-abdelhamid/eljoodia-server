const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach(room => {
    if (room) {
      io.of('/api').to(room).emit(eventName, eventData);
      console.log(`[${new Date().toISOString()}] Emitted ${eventName} to room ${room}:`, eventData);
    }
  });
};

const createNotification = async (userId, type, message, data = {}, io) => {
  if (!mongoose.isValidObjectId(userId)) {
    console.error(`[${new Date().toISOString()}] Invalid userId: ${userId}`);
    throw new Error('Invalid user ID');
  }

  const eventId = data.eventId || `${data.orderId || data.taskId || 'generic'}-${type}-${userId}-${Date.now()}`;
  const existingNotification = await Notification.findOne({ 'data.eventId': eventId });
  if (existingNotification) {
    console.log(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
    return existingNotification;
  }

  const notificationData = {
    user: userId,
    type,
    message,
    data: {
      ...data,
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    },
    read: false,
    createdAt: new Date(),
  };

  const notification = await Notification.create(notificationData);
  console.log(`[${new Date().toISOString()}] Created notification:`, notification);

  const rooms = [
    `user-${userId}`,
    data.chefId ? `chef-${data.chefId}` : null,
    data.branchId ? `branch-${data.branchId}` : null,
    data.departmentId ? `department-${data.departmentId}` : null,
    'admin',
    type.includes('production') || type.includes('task') ? 'production' : null,
  ].filter(Boolean);

  await emitSocketEvent(io, rooms, 'newNotification', {
    _id: notification._id.toString(),
    type: notification.type,
    message: notification.message,
    data: notification.data,
    read: notification.read,
    createdAt: notification.createdAt.toISOString(),
    sound: notification.data.sound,
    vibrate: notification.data.vibrate,
  });

  return notification;
};

const notifyUsers = async (io, users, type, message, data = {}) => {
  const notifications = await Promise.all(
    users.map(async (user) => {
      const userId = user._id.toString();
      return await createNotification(userId, type, message, data, io);
    })
  );
  return notifications;
};

module.exports = { createNotification, notifyUsers, emitSocketEvent };