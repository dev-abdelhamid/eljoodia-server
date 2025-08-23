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
      branchId: decoded.branchId || user.branch?._id?.toString() || null,
      branchName: user.branch?.name,
      departmentId: decoded.departmentId || user.department?._id.toString() || null,
      departmentName: user.department?.name,
    };
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Socket auth error for /api namespace: ${err.message}`);
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
    if (role === 'branch' && branchId) {
      socket.join(`branch-${branchId}`);
      rooms.push(`branch-${branchId}`);
    }
    if (role === 'chef' && chefId) {
      socket.join(`chef-${chefId}`);
      rooms.push(`chef-${chefId}`);
    }
    if (departmentId) {
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
    apiNamespace.to('admin').emit('orderCreated', { ...data, sound: '/notification.mp3', vibrate: [300, 100, 300] });
    apiNamespace.to('production').emit('orderCreated', { ...data, sound: '/notification.mp3', vibrate: [300, 100, 300] });
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderCreated', { ...data, sound: '/notification.mp3', vibrate: [300, 100, 300] });
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
      departments.forEach((departmentId) => {
        apiNamespace.to(`department-${departmentId}`).emit('orderCreated', { ...data, sound: '/order-created.mp3', vibrate: [300, 100, 300] });
      });
    }
  });

  socket.on('orderApproved', (data) => {
    apiNamespace.to('admin').emit('orderApproved', { ...data, sound: '/order-approved.mp3', vibrate: [200, 100, 200] });
    apiNamespace.to('production').emit('orderApproved', { ...data, sound: '/order-approved.mp3', vibrate: [200, 100, 200] });
    if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderApproved', { ...data, sound: '/order-approved.mp3', vibrate: [200, 100, 200] });
  });

  socket.on('taskAssigned', (data) => {
    apiNamespace.to('admin').emit('taskAssigned', { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] });
    apiNamespace.to('production').emit('taskAssigned', { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] });
    if (data.chef) apiNamespace.to(`chef-${data.chef}`).emit('taskAssigned', { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] });
    if (data.order?.branch) apiNamespace.to(`branch-${data.order.branch}`).emit('taskAssigned', { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] });
    if (data.product?.department?._id) apiNamespace.to(`department-${data.product.department._id}`).emit('taskAssigned', { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] });
  });

  socket.on('taskStatusUpdated', ({ taskId, status, orderId, itemId }) => {
    const eventData = { taskId, status, orderId, itemId, sound: '/notification.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('taskStatusUpdated', eventData);
    apiNamespace.to('production').emit('taskStatusUpdated', eventData);
    if (orderId) {
      require('./models/Order').findById(orderId).then((order) => {
        if (order?.branch) {
          apiNamespace.to(`branch-${order.branch}`).emit('taskStatusUpdated', eventData);
        }
      });
    }
  });

  socket.on('taskCompleted', (data) => {
    const eventData = { ...data, sound: '/notification.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('taskCompleted', eventData);
    apiNamespace.to('production').emit('taskCompleted', eventData);
    if (data.chef) apiNamespace.to(`chef-${data.chef}`).emit('taskCompleted', eventData);
    if (data.orderId) {
      require('./models/Order').findById(data.orderId).then((order) => {
        if (order?.branch) {
          apiNamespace.to(`branch-${order.branch}`).emit('taskCompleted', eventData);
        }
      });
    }
  });

  socket.on('orderStatusUpdated', async ({ orderId, status, user }) => {
    const eventData = { orderId, status, user, sound: '/status-updated.mp3', vibrate: [200, 100, 200] };
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
        sound: '/notification.mp3',
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
        sound: '/order-in-transit.mp3',
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
        sound: '/order-delivered.mp3',
        vibrate: [300, 100, 300],
      };
      apiNamespace.to('admin').emit('orderDelivered', deliveredEventData);
      apiNamespace.to('production').emit('orderDelivered', deliveredEventData);
      if (order.branch) {
        apiNamespace.to(`branch-${order.branch._id}`).emit('orderDelivered', deliveredEventData);
      }
    }
  });

  socket.on('returnStatusUpdated', ({ returnId, status, returnNote }) => {
    const eventData = { returnId, status, returnNote, sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('returnStatusUpdated', eventData);
    apiNamespace.to('production').emit('returnStatusUpdated', eventData);
    require('./models/Return').findById(returnId).then((returnRequest) => {
      if (returnRequest?.order?.branch) {
        apiNamespace.to(`branch-${returnRequest.order.branch}`).emit('returnStatusUpdated', eventData);
      }
    });
  });

  socket.on('missingAssignments', async (data) => {
    const eventData = { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] };
    apiNamespace.to('admin').emit('missingAssignments', eventData);
    apiNamespace.to('production').emit('missingAssignments', eventData);
    const order = await require('./models/Order').findById(data.orderId).lean();
    if (order?.branch) {
      apiNamespace.to(`branch-${order.branch}`).emit('missingAssignments', eventData);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${new Date().toISOString()}] User disconnected from /api namespace: ${socket.id}, Reason: ${reason}`);
  });
});

connectDB().catch((err) => {
  console.error(`[${new Date().toISOString()}] Failed to connect to MongoDB: ${err.message}`);
  process.exit(1);
});

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
app.use('/api/inventory', inventoryRoutes); // تصحيح المسار ليكون بالحروف الصغيرة للتوافق مع المعايير
app.use('/api/sales', salesRoutes);
app.use('/api/notifications', notificationsRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'production', time: new Date().toISOString() });
});

// معالجة الأخطاء العامة
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
