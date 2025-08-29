const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: [200, 100, 200],
    timestamp: new Date().toISOString(),
  };
  const uniqueRooms = new Set(rooms.filter(Boolean));
  uniqueRooms.forEach(room => io.of('/api').to(room).emit('newNotification', eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
    eventData: eventDataWithSound,
  });
};

module.exports = { emitSocketEvent };