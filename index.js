const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

require('dotenv').config();

let compression;
try {
  compression = require('compression');
} catch (err) {
  console.warn(`[${new Date().toISOString()}] Compression module not found. Skipping compression middleware.`);
}

const connectDB = require('./config/database');
const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const productRoutes = require('./routes/products');
const branchRoutes = require('./routes/branches');
const chefRoutes = require('./routes/chefs');
const departmentRoutes = require('./routes/departments');
const returnRoutes = require('./routes/returns');
const inventoryRoutes = require('./routes/Inventory');
const salesRoutes = require('./routes/sales');
const notificationsRoutes = require('./routes/notifications');
const { createNotification } = require('./utils/notifications');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
  'https://eljoodia-server-production.up.railway.app',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error(`[${new Date().toISOString()}] CORS error: Origin ${origin} not allowed`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
});

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        ...allowedOrigins.map((origin) => origin.replace(/^https?/, 'wss')),
        ...allowedOrigins,
      ],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", 'https://eljoodia-server-production.up.railway.app'],
    },
  })
);

app.use('/sounds', express.static('public/sounds'));

const apiNamespace = io.of('/api');
apiNamespace.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.error(`[${new Date().toISOString()}] No token provided for /api namespace: ${socket.id}`);
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const cleanedToken = token.startsWith('Bearer ') ? token.replace('Bearer ', '') : token;
    const decoded = jwt.verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
    const user = await require('./models/User').findById(decoded.id)
      .populate('branch', 'name _id')
      .populate('department', 'name')
      .lean();
    if (!user) {
      console.error(`[${new Date().toISOString()}] User not found for /api namespace: ${decoded.id}`);
      return next(new Error('Authentication error: User not found'));
    }
    socket.user = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      branchId: user.branch?._id?.toString() || null,
      branchName: user.branch?.name || null,
      departmentId: user.department?._id?.toString() || null,
      departmentName: user.department?.name || null,
    };
    console.log(`[${new Date().toISOString()}] Socket authenticated:`, socket.user);
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Socket auth error for /api namespace:`, err.message);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

apiNamespace.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Connected to /api namespace: ${socket.id}, User: ${socket.user.username}`);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId, userId }) => {
    const rooms = [];
    if (role === 'admin') {
      socket.join('admin');
      rooms.push('admin');
    }
    if (role === 'production') {
      socket.join('production');
      rooms.push('production');
    }
    if (role === 'branch' && branchId && mongoose.isValidObjectId(branchId)) {
      socket.join(`branch-${branchId}`);
      rooms.push(`branch-${branchId}`);
    }
    if (role === 'chef' && chefId) {
      socket.join(`chef-${chefId}`);
      rooms.push(`chef-${chefId}`);
    }
    if (departmentId && mongoose.isValidObjectId(departmentId)) {
      socket.join(`department-${departmentId}`);
      rooms.push(`department-${departmentId}`);
    }
    if (userId) {
      socket.join(`user-${userId}`);
      rooms.push(`user-${userId}`);
    }
    console.log(`[${new Date().toISOString()}] User ${socket.user.username} (${socket.user.id}) joined rooms: ${rooms.join(', ')}`);
  });

  socket.on('orderCreated', (data) => {
    const eventData = { ...data, sound: '/order-created.mp3', vibrate: [300, 100, 300] };
    apiNamespace.to('admin').emit('orderCreated', eventData);
    apiNamespace.to('production').emit('orderCreated', eventData);
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderCreated', eventData);
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
      departments.forEach((departmentId) => {
        apiNamespace.to(`department-${departmentId}`).emit('orderCreated', eventData);
      });
    }
  });

  socket.on('orderApproved', (data) => {
    const eventData = { ...data, sound: '/order-approved.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('orderApproved', eventData);
    apiNamespace.to('production').emit('orderApproved', eventData);
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderApproved', eventData);
  });

  socket.on('taskAssigned', (data) => {
    const eventData = { ...data, sound: '/task-assigned.mp3', vibrate: [400, 100, 400] };
    apiNamespace.to('admin').emit('taskAssigned', eventData);
    apiNamespace.to('production').emit('taskAssigned', eventData);
    if (data.chef) apiNamespace.to(`chef-${data.chef._id || data.chef}`).emit('taskAssigned', eventData);
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('taskAssigned', eventData);
    if (data.product?.department?._id) apiNamespace.to(`department-${data.product.department._id}`).emit('taskAssigned', eventData);
  });

  socket.on('taskStatusUpdated', ({ taskId, status, orderId, itemId }) => {
    const eventData = { taskId, status, orderId, itemId, sound: '/status-updated.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('taskStatusUpdated', eventData);
    apiNamespace.to('production').emit('taskStatusUpdated', eventData);
    if (orderId) {
      require('./models/Order').findById(orderId)
        .populate('branch', 'name _id')
        .lean()
        .then((order) => {
          if (order?.branch?._id) {
            apiNamespace.to(`branch-${order.branch._id}`).emit('taskStatusUpdated', eventData);
          }
        });
    }
  });

  socket.on('taskCompleted', (data) => {
    const eventData = { ...data, sound: '/task-completed.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('taskCompleted', eventData);
    apiNamespace.to('production').emit('taskCompleted', eventData);
    if (data.chef) apiNamespace.to(`chef-${data.chef}`).emit('taskCompleted', eventData);
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('taskCompleted', eventData);
  });

  socket.on('orderStatusUpdated', async ({ orderId, status, user }) => {
    const eventData = { orderId, status, user, sound: '/status-updated.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('orderStatusUpdated', eventData);
    apiNamespace.to('production').emit('orderStatusUpdated', eventData);
    const order = await require('./models/Order').findById(orderId).populate('branch', 'name _id').lean();
    if (order?.branch?._id );
    if (order?.branch?._id) {
      apiNamespace.to(`branch-${order.branch._id}`).emit('orderStatusUpdated', eventData);
    }
  });

  socket.on('orderCompleted', async (data) => {
    const eventData = { ...data, sound: '/order-completed.mp3', vibrate: [300, 100, 300] };
    apiNamespace.to('admin').emit('orderCompleted', eventData);
    apiNamespace.to('production').emit('orderCompleted', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('orderCompleted', eventData);
      console.log(`[${new Date().toISOString()}] Emitted orderCompleted to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('orderInTransit', async (data) => {
    const eventData = { ...data, sound: '/order-in-transit.mp3', vibrate: [300, 100, 300] };
    apiNamespace.to('admin').emit('orderInTransit', eventData);
    apiNamespace.to('production').emit('orderInTransit', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('orderInTransit', eventData);
      console.log(`[${new Date().toISOString()}] Emitted orderInTransit to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('orderDelivered', async (data) => {
    const eventData = { ...data, sound: '/order-delivered.mp3', vibrate: [300, 100, 300] };
    apiNamespace.to('admin').emit('orderDelivered', eventData);
    apiNamespace.to('production').emit('orderDelivered', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('orderDelivered', eventData);
      console.log(`[${new Date().toISOString()}] Emitted orderDelivered to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('returnStatusUpdated', async (data) => {
    const eventData = { ...data, sound: data.status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('returnStatusUpdated', eventData);
    apiNamespace.to('production').emit('returnStatusUpdated', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('returnStatusUpdated', eventData);
      console.log(`[${new Date().toISOString()}] Emitted returnStatusUpdated to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('newNotification', async (data) => {
    const eventData = { ...data, sound: data.sound || '/notification.mp3', vibrate: data.vibrate || [200, 100, 200] };
    apiNamespace.to(`user-${data.user._id}`).emit('newNotification', eventData);
    if (data.user.role === 'admin') apiNamespace.to('admin').emit('newNotification', eventData);
    if (data.user.role === 'production') apiNamespace.to('production').emit('newNotification', eventData);
    if (data.user.role === 'branch' && data.branch?._id) {
      apiNamespace.to(`branch-${data.branch._id}`).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Emitted newNotification to branch-${data.branch._id}:`, eventData);
    }
    if (data.user.role === 'chef' && data.user.department?._id) {
      apiNamespace.to(`department-${data.user.department._id}`).emit('newNotification', eventData);
    }
  });

  socket.on('notificationUpdated', (data) => {
    apiNamespace.to(`user-${data.id}`).emit('notificationUpdated', data);
    console.log(`[${new Date().toISOString()}] Emitted notificationUpdated to user-${data.id}:`, data);
  });

  socket.on('notificationDeleted', (data) => {
    apiNamespace.to(`user-${data.id}`).emit('notificationDeleted', data);
    console.log(`[${new Date().toISOString()}] Emitted notificationDeleted to user-${data.id}:`, data);
  });

  socket.on('allNotificationsRead', (data) => {
    apiNamespace.to(`user-${data.user}`).emit('allNotificationsRead', data);
    console.log(`[${new Date().toISOString()}] Emitted allNotificationsRead to user-${data.user}:`, data);
  });

  socket.on('disconnect', () => {
    console.log(`[${new Date().toISOString()}] Disconnected from /api namespace: ${socket.id}, User: ${socket.user.username}`);
  });

  socket.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Socket error: ${err.message}`);
  });
});

app.set('io', apiNamespace);

app.use(morgan('combined'));
if (compression) app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.',
});
app.use(limiter);

app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/chefs', chefRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/notifications', notificationsRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Eljoodia Server' });
});

app.use((req, res) => {
  console.error(`[${new Date().toISOString()}] 404 Not Found: ${req.method} ${req.url}`);
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Server error:`, {
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
    user: req.user ? req.user.id : 'unauthenticated',
  });
  res.status(500).json({ success: false, message: 'Internal Server Error', error: err.message });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
  });
}).catch((err) => {
  console.error(`[${new Date().toISOString()}] Database connection error:`, err);
  process.exit(1);
});

module.exports = { app, server, io: apiNamespace };