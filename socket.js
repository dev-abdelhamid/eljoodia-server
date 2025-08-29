const socketIo = require('socket.io');

let io;

const initSocket = (server) => {
  io = socketIo(server, {
    cors: {
      origin: [
        process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app',
        'http://localhost:5173',
      ],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  });

  const apiNamespace = io.of('/api');
  apiNamespace.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      console.error(`[${new Date().toISOString()}] No token provided for /api namespace: ${socket.id}`);
      return next(new Error('Authentication error: No token provided'));
    }
    try {
      const cleanedToken = token.replace('Bearer ', '');
      const decoded = require('jsonwebtoken').verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
      const user = await require('./models/User').findById(decoded.id)
        .select('username role branch department')
        .populate('branch', 'name')
        .populate('department', 'name')
        .lean();
      if (!user) {
        console.error(`[${new Date().toISOString()}] User not found for /api namespace: ${decoded.id}`);
        return next(new Error('Authentication error: User not found'));
      }
      socket.user = {
        id: user._id,
        username: user.username,
        role: user.role,
        branchId: user.branch?._id?.toString(),
        branchName: user.branch?.name,
        departmentId: user.department?._id?.toString(),
        departmentName: user.department?.name,
      };
      next();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Socket auth error: ${err.message}`);
      return next(new Error(`Authentication error: ${err.message}`));
    }
  });

  apiNamespace.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Connected to /api namespace: ${socket.id}, User: ${socket.user.username}`);
    
    socket.on('joinRoom', ({ role, branchId, departmentId, chefId, userId }) => {
      if (socket.user.id !== userId) {
        console.error(`[${new Date().toISOString()}] Unauthorized room join attempt: ${socket.user.id} as ${userId}`);
        return socket.emit('error', { message: 'Unauthorized' });
      }

      const rooms = [
        `user-${userId}`,
        role,
        ...(branchId && role === 'branch' ? [`branch-${branchId}`] : []),
        ...(departmentId && role === 'chef' ? [`department-${departmentId}`] : []),
        ...(chefId && role === 'chef' ? [`chef-${chefId}`] : []),
      ];

      rooms.forEach((room) => {
        socket.join(room);
        console.log(`[${new Date().toISOString()}] ${socket.user.username} joined room: ${room}`);
      });
    });

    require('./notifications').setupNotifications(apiNamespace, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[${new Date().toISOString()}] Socket disconnected: ${socket.id}, Reason: ${reason}`);
    });
  });

  return io;
};

module.exports = { initSocket };