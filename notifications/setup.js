const orderCreatedHandler = require('./handlers/orderCreated');
const orderStatusUpdatedHandler = require('./handlers/orderStatusUpdated');

module.exports = (io, socket) => {
  socket.on('orderCreated', (data) => orderCreatedHandler(data, io));
  socket.on('orderStatusUpdated', (data) => orderStatusUpdatedHandler(data, io));
};