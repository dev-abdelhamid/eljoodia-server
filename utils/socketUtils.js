const { createNotification } = require('./notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms,
    eventData: { ...eventData, sound: eventData.sound, vibrate: eventData.vibrate }
  });
};

const notifyUsers = async (io, users, type, message, data) => {
  await Promise.all(users.map(user => 
    createNotification(user._id, type, message, data, io)
      .catch(err => console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id}:`, err))
  ));
};

module.exports = { emitSocketEvent, notifyUsers };