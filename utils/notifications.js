const handleOrderCreated = require('./notifications/handlers/orderCreated');
const handleOrderStatusUpdated = require('./notifications/handlers/orderStatusUpdated');
const handleTaskAssigned = require('./notifications/handlers/taskAssigned');
const handleTaskStatusUpdated = require('./notifications/handlers/taskStatusUpdated');
const handleOrderCancelled = require('./notifications/handlers/orderCancelled');

const setupNotifications = (io, socket) => {
  console.log(`[${new Date().toISOString()}] Setting up notifications for socket: ${socket.id}`);

  // الاستماع إلى حدث إنشاء الطلب
  socket.on('orderCreated', (eventData) => {
    console.log(`[${new Date().toISOString()}] Received orderCreated event:`, eventData);
    handleOrderCreated(io, eventData);
  });

  // الاستماع إلى حدث تحديث حالة الطلب
  socket.on('orderStatusUpdated', (eventData) => {
    console.log(`[${new Date().toISOString()}] Received orderStatusUpdated event:`, eventData);
    handleOrderStatusUpdated(io, eventData);
  });

  // الاستماع إلى حدث تعيين المهمة
  socket.on('taskAssigned', (eventData) => {
    console.log(`[${new Date().toISOString()}] Received taskAssigned event:`, eventData);
    handleTaskAssigned(io, eventData);
  });

  // الاستماع إلى حدث تحديث حالة المهمة
  socket.on('taskStatusUpdated', (eventData) => {
    console.log(`[${new Date().toISOString()}] Received taskStatusUpdated event:`, eventData);
    handleTaskStatusUpdated(io, eventData);
  });

  // الاستماع إلى حدث إلغاء الطلب
  socket.on('orderCancelled', (eventData) => {
    console.log(`[${new Date().toISOString()}] Received orderCancelled event:`, eventData);
    handleOrderCancelled(io, eventData);
  });
};

module.exports = { setupNotifications };