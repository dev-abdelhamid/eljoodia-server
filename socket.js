const socketIo = require('socket.io');

let io;

const initSocket = (server) => {
  io = socketIo(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    socket.on('joinRoom', ({ role, branchId, departmentId, userId }) => {
      if (role === 'production' && departmentId) {
        socket.join(`department:${departmentId}`);
      } else if (branchId) {
        socket.join(`branch:${branchId}`);
      }
      socket.join(`user:${userId}`);
    });
  });
};

const emitOrderEvent = (event, data) => {
  if (!io) return;

  const { orderId, user } = data;
  const order = data.orderId ? { orderId } : data;

  if (user?.role === 'production' && user?.department) {
    io.to(`department:${user.department}`).emit(event, order);
  } else if (user?.branchId) {
    io.to(`branch:${user.branchId}`).emit(event, order);
  }
  io.to(`user:${user?._id}`).emit(event, order);
};

module.exports = { initSocket, emitOrderEvent };
