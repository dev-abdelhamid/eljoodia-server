const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const path = require('path');
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

// توفير ملفات الصوت في المجلد العام
app.use('/public', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET');
  }
}));

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
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();
    if (!user) {
      console.error(`[${new Date().toISOString()}] User not found for /api namespace: ${decoded.id}`);
      return next(new Error('Authentication error: User not found'));
    }
    socket.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      branchId: decoded.branchId || null,
      branchName: user.branch?.name,
      departmentId: decoded.departmentId || null,
      departmentName: user.department?.name,
    };
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Socket auth error for /api namespace: ${err.message}`);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

apiNamespace.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Connected to /api namespace: ${socket.id}, User: ${socket.user.username} (${socket.user.role})`);
  console.log(`[${new Date().toISOString()}] Active connections: ${io.of('/api').server.engine.clientsCount}`);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId, userId }) => {
    const rooms = [];
    if (role === 'admin') {
      socket.join('admin');
      rooms.push('admin');
    }
    if (role === 'branch' && branchId && require('mongoose').isValidObjectId(branchId)) {
      socket.join(`branch-${branchId}`);
      rooms.push(`branch-${branchId}`);
    }
    if (role === 'production' && departmentId && require('mongoose').isValidObjectId(departmentId)) {
      socket.join('production');
      socket.join(`department-${departmentId}`);
      rooms.push('production', `department-${departmentId}`);
    }
    if (role === 'chef' && chefId && require('mongoose').isValidObjectId(chefId)) {
      socket.join(`chef-${chefId}`);
      rooms.push(`chef-${chefId}`);
    }
    if (userId && require('mongoose').isValidObjectId(userId)) {
      socket.join(`user-${userId}`);
      rooms.push(`user-${userId}`);
    }
    if (rooms.length === 0) {
      console.warn(`[${new Date().toISOString()}] No rooms joined for user ${socket.user.username}:`, { role, branchId, chefId, departmentId, userId });
    } else {
      console.log(`[${new Date().toISOString()}] User ${socket.user.username} (${socket.user.id}, ${socket.user.role}) joined rooms: ${rooms.join(', ')}`);
    }
  });

  socket.on('orderCreated', (data) => {
    const eventData = { ...data, sound: data.sound || '/public/notification.mp3', vibrate: data.vibrate || [300, 100, 300] };
    apiNamespace.to('admin').emit('orderCreated', eventData);
    apiNamespace.to('production').emit('orderCreated', eventData);
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderCreated', eventData);
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
      departments.forEach((departmentId) => {
        apiNamespace.to(`department-${departmentId}`).emit('orderCreated', eventData);
      });
    }
    console.log(`[${new Date().toISOString()}] Emitted orderCreated:`, eventData);
  });

  socket.on('orderApproved', (data) => {
    const eventData = { ...data, sound: data.sound || '/public/order-approved.mp3', vibrate: data.vibrate || [200, 100, 200] };
    apiNamespace.to('admin').emit('orderApproved', eventData);
    apiNamespace.to('production').emit('orderApproved', eventData);
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderApproved', eventData);
    console.log(`[${new Date().toISOString()}] Emitted orderApproved:`, eventData);
  });

  socket.on('taskAssigned', (data) => {
    const eventData = { ...data, sound: data.sound || '/public/task-assigned.mp3', vibrate: data.vibrate || [400, 100, 400] };
    apiNamespace.to('admin').emit('taskAssigned', eventData);
    apiNamespace.to('production').emit('taskAssigned', eventData);
    if (data.chef) apiNamespace.to(`chef-${data.chef._id || data.chef}`).emit('taskAssigned', eventData);
    if (data.order?.branch) apiNamespace.to(`branch-${data.order.branch}`).emit('taskAssigned', eventData);
    if (data.product?.department?._id) apiNamespace.to(`department-${data.product.department._id}`).emit('taskAssigned', eventData);
    console.log(`[${new Date().toISOString()}] Emitted taskAssigned:`, eventData);
  });

  socket.on('taskStatusUpdated', ({ taskId, status, orderId, itemId }) => {
    const eventData = { taskId, status, orderId, itemId, sound: '/public/status-updated.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('taskStatusUpdated', eventData);
    apiNamespace.to('production').emit('taskStatusUpdated', eventData);
    if (orderId) {
      require('./models/Order').findById(orderId).then((order) => {
        if (order?.branch) {
          apiNamespace.to(`branch-${order.branch}`).emit('taskStatusUpdated', eventData);
        }
      });
    }
    console.log(`[${new Date().toISOString()}] Emitted taskStatusUpdated:`, eventData);
  });

  socket.on('taskCompleted', (data) => {
    const eventData = { ...data, sound: '/public/notification.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('taskCompleted', eventData);
    apiNamespace.to('production').emit('taskCompleted', eventData);
    if (data.chef) apiNamespace.to(`chef-${data.chef._id || data.chef}`).emit('taskCompleted', eventData);
    if (data.orderId) {
      require('./models/Order').findById(data.orderId).then((order) => {
        if (order?.branch) {
          apiNamespace.to(`branch-${order.branch}`).emit('taskCompleted', eventData);
        }
      });
    }
    console.log(`[${new Date().toISOString()}] Emitted taskCompleted:`, eventData);
  });

  socket.on('orderStatusUpdated', async ({ orderId, status, user }) => {
    const eventData = { orderId, status, user, sound: '/public/status-updated.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('orderStatusUpdated', eventData);
    apiNamespace.to('production').emit('orderStatusUpdated', eventData);
    const order = await require('./models/Order').findById(orderId).populate('branch', 'name').lean();
    if (order?.branch) {
      apiNamespace.to(`branch-${order.branch._id}`).emit('orderStatusUpdated', eventData);
    }
    if (status === 'completed' && order) {
      const completedEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/public/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      apiNamespace.to('admin').emit('orderCompleted', completedEventData);
      apiNamespace.to('production').emit('orderCompleted', completedEventData);
      if (order.branch) {
        apiNamespace.to(`branch-${order.branch._id}`).emit('orderCompleted', completedEventData);
      }
    }
    if (status === 'in_transit' && order) {
      const transitEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        transitStartedAt: new Date().toISOString(),
        sound: '/public/order-in-transit.mp3',
        vibrate: [300, 100, 300],
      };
      apiNamespace.to('admin').emit('orderInTransit', transitEventData);
      apiNamespace.to('production').emit('orderInTransit', transitEventData);
      if (order.branch) {
        apiNamespace.to(`branch-${order.branch._id}`).emit('orderInTransit', transitEventData);
      }
    }
    if (status === 'delivered' && order) {
      const deliveredEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        deliveredAt: new Date().toISOString(),
        sound: '/public/order-delivered.mp3',
        vibrate: [300, 100, 300],
      };
      apiNamespace.to('admin').emit('orderDelivered', deliveredEventData);
      apiNamespace.to('production').emit('orderDelivered', deliveredEventData);
      if (order.branch) {
        apiNamespace.to(`branch-${order.branch._id}`).emit('orderDelivered', deliveredEventData);
      }
    }
    console.log(`[${new Date().toISOString()}] Emitted orderStatusUpdated:`, eventData);
  });

  socket.on('returnStatusUpdated', ({ returnId, status, returnNote }) => {
    const eventData = { returnId, status, returnNote, sound: status === 'approved' ? '/public/return-approved.mp3' : '/public/return-rejected.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('returnStatusUpdated', eventData);
    apiNamespace.to('production').emit('returnStatusUpdated', eventData);
    require('./models/Return').findById(returnId).then((returnRequest) => {
      if (returnRequest?.order?.branch) {
        apiNamespace.to(`branch-${returnRequest.order.branch}`).emit('returnStatusUpdated', eventData);
      }
    });
    console.log(`[${new Date().toISOString()}] Emitted returnStatusUpdated:`, eventData);
  });

  socket.on('missingAssignments', (data) => {
    const eventData = { ...data, sound: '/public/notification.mp3', vibrate: [400, 100, 400] };
    apiNamespace.to('admin').emit('missingAssignments', eventData);
    apiNamespace.to('production').emit('missingAssignments', eventData);
    require('./models/Order').findById(data.orderId).then((order) => {
      if (order?.branch) {
        apiNamespace.to(`branch-${order.branch}`).emit('missingAssignments', eventData);
      }
    });
    console.log(`[${new Date().toISOString()}] Emitted missingAssignments:`, eventData);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${new Date().toISOString()}] User disconnected from /api namespace: ${socket.id}, Reason: ${reason}`);
  });
});

connectDB().catch((err) => {
  console.error(`[${new Date().toISOString()}] Failed to connect to MongoDB: ${err.message}`);
  process.exit(1);
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
      mediaSrc: ["'self'", ...allowedOrigins], // Allow audio files from public and origins
    },
  })
);

app.use('/socket.io', (req, res, next) => next());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);

if (compression) app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.set('io', io);

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

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'production', time: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error: ${err.message}, Stack: ${err.stack}`);
  res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM. Closing server gracefully.`);
  server.close(() => {
    require('mongoose').connection.close(false, () => {
      console.log(`[${new Date().toISOString()}] MongoDB connection closed.`);
      process.exit(0);
    });
  });
});