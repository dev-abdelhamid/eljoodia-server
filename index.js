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
const { createNotification } = require('./utils/notification');

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
      departmentId: decoded.departmentId || user.department?._id?.toString() || null,
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

  const emitWithNotification = async (rooms, eventName, data) => {
    const eventData = {
      ...data,
      sound: '/notification.mp3',
      vibrate: data.vibrate || [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    rooms.forEach((room) => {
      apiNamespace.to(room).emit(eventName, eventData);
      console.log(`[${new Date().toISOString()}] Emitting ${eventName} to room: ${room}`, eventData);
    });

    let departmentIds = [];
    if (data.orderId) {
      const order = await require('./models/Order').findById(data.orderId).lean();
      if (order && order.items) {
        departmentIds = [...new Set(order.items.map((item) => item.department?._id?.toString()).filter(Boolean))];
      }
    } else if (data.departmentId) {
      departmentIds = [data.departmentId];
    }

    const users = await require('./models/User').find({
      $or: [
        { role: 'admin' },
        { role: 'production' },
        { role: 'branch', branch: rooms.find((r) => r.startsWith('branch-'))?.replace('branch-', '') },
        { _id: rooms.find((r) => r.startsWith('user-'))?.replace('user-', '') },
        { role: 'chef', department: { $in: departmentIds } },
      ],
    }).lean();

    for (const user of users) {
      let message;
      switch (eventName) {
        case 'orderCreated':
          message = `طلب جديد ${data.orderNumber || data.orderId}`;
          break;
        case 'orderApproved':
          message = `تمت الموافقة على الطلب ${data.orderNumber || data.orderId}`;
          break;
        case 'orderStatusUpdated':
          message = `تم تحديث حالة الطلب ${data.orderId} إلى ${data.status}`;
          break;
        case 'taskAssigned':
          message = `تم تعيين مهمة جديدة: ${data.product?.name || 'غير معروف'}`;
          break;
        case 'taskStatusUpdated':
          message = `تم تحديث حالة المهمة ${data.taskId} إلى ${data.status}`;
          break;
        case 'taskCompleted':
          message = `تم إكمال المهمة ${data.taskId} للطلب ${data.orderId}`;
          break;
        case 'orderCompleted':
          message = `تم إكمال الطلب ${data.orderNumber || data.orderId}`;
          break;
        case 'orderInTransit':
          message = `الطلب ${data.orderNumber || data.orderId} في النقل`;
          break;
        case 'orderDelivered':
          message = `تم تسليم الطلب ${data.orderNumber || data.orderId}`;
          break;
        case 'missingAssignments':
          message = `مهام مفقودة للمنتج ${data.productName} في الطلب ${data.orderId}`;
          break;
        case 'returnCreated':
          message = `تم إنشاء طلب مرتجع ${data.returnId} للطلب ${data.orderId}`;
          break;
        case 'returnStatusUpdated':
          message = `تم تحديث حالة المرتجع ${data.returnId} إلى ${data.status}`;
          break;
        default:
          message = `إشعار جديد: ${eventName}`;
      }

      await createNotification(
        user._id,
        eventName,
        message,
        {
          orderId: data.orderId,
          returnId: data.returnId,
          taskId: data.taskId,
          itemId: data.itemId,
          sound: '/notification.mp3',
          vibrate: [200, 100, 200],
        },
        io
      );
    }
  };

  socket.on('orderCreated', (data) => {
    const rooms = ['admin', 'production'];
    if (data.branchId) rooms.push(`branch-${data.branchId}`);
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id?.toString()).filter(Boolean))];
      departments.forEach((departmentId) => rooms.push(`department-${departmentId}`));
    }
    emitWithNotification(rooms, 'orderCreated', data);
  });

  socket.on('orderApproved', (data) => {
    const rooms = ['admin', 'production'];
    if (data.branchId) rooms.push(`branch-${data.branchId}`);
    emitWithNotification(rooms, 'orderApproved', data);
  });

  socket.on('taskAssigned', (data) => {
    const rooms = ['admin', 'production'];
    if (data.chef) rooms.push(`chef-${data.chef}`);
    if (data.order?.branch) rooms.push(`branch-${data.order.branch}`);
    if (data.product?.department?._id) rooms.push(`department-${data.product.department._id}`);
    emitWithNotification(rooms, 'taskAssigned', data);
  });

  socket.on('taskStatusUpdated', async ({ taskId, status, orderId, itemId, userId }) => {
    const eventData = { taskId, status, orderId, itemId, userId };
    const rooms = ['admin', 'production', `user-${userId}`];
    if (orderId) {
      const order = await require('./models/Order').findById(orderId).lean();
      if (order?.branch) rooms.push(`branch-${order.branch}`);
    }
    emitWithNotification(rooms, 'taskStatusUpdated', eventData);
  });

  socket.on('taskCompleted', async (data) => {
    const rooms = ['admin', 'production', `user-${data.chef}`];
    if (data.orderId) {
      const order = await require('./models/Order').findById(data.orderId).lean();
      if (order?.branch) rooms.push(`branch-${order.branch}`);
    }
    emitWithNotification(rooms, 'taskCompleted', data);
  });

  socket.on('orderStatusUpdated', async ({ orderId, status, user, userId }) => {
    const order = await require('./models/Order').findById(orderId).populate('branch', 'name').lean();
    const eventData = { orderId, status, user, userId };
    const rooms = ['admin', 'production', `user-${userId}`];
    if (order?.branch) rooms.push(`branch-${order.branch._id}`);
    emitWithNotification(rooms, 'orderStatusUpdated', eventData);

    if (status === 'completed' && order) {
      const completedEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        completedAt: new Date().toISOString(),
      };
      emitWithNotification(['admin', 'production', `branch-${order.branch._id}`, `user-${userId}`], 'orderCompleted', completedEventData);
    }
    if (status === 'in_transit' && order) {
      const transitEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        transitStartedAt: new Date().toISOString(),
      };
      emitWithNotification(['admin', 'production', `branch-${order.branch._id}`, `user-${userId}`], 'orderInTransit', transitEventData);
    }
    if (status === 'delivered' && order) {
      const deliveredEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        deliveredAt: new Date().toISOString(),
      };
      emitWithNotification(['admin', 'production', `branch-${order.branch._id}`, `user-${userId}`], 'orderDelivered', deliveredEventData);
    }
  });

  socket.on('returnStatusUpdated', async ({ returnId, status, returnNote, userId }) => {
    const eventData = { returnId, status, returnNote };
    const rooms = ['admin', 'production', `user-${userId}`];
    const returnRequest = await require('./models/Return').findById(returnId).lean();
    if (returnRequest?.order?.branch) rooms.push(`branch-${returnRequest.order.branch}`);
    emitWithNotification(rooms, 'returnStatusUpdated', eventData);
  });

  socket.on('missingAssignments', async (data) => {
    const rooms = ['admin', 'production'];
    if (data.orderId) {
      const order = await require('./models/Order').findById(data.orderId).lean();
      if (order?.branch) rooms.push(`branch-${order.branch}`);
    }
    emitWithNotification(rooms, 'missingAssignments', data);
  });

  socket.on('notificationRead', ({ notificationId, userId }) => {
    const rooms = [`user-${userId}`];
    apiNamespace.to(rooms).emit('notificationUpdated', { id: notificationId, read: true });
    console.log(`[${new Date().toISOString()}] Notification ${notificationId} marked as read for user ${userId}`);
  });

  socket.on('allNotificationsRead', ({ userId }) => {
    const rooms = [`user-${userId}`];
    apiNamespace.to(rooms).emit('allNotificationsRead', { user: userId });
    console.log(`[${new Date().toISOString()}] All notifications marked as read for user ${userId}`);
  });

  socket.on('notificationsCleared', ({ userId }) => {
    const rooms = [`user-${userId}`];
    apiNamespace.to(rooms).emit('notificationsCleared', { user: userId });
    console.log(`[${new Date().toISOString()}] Notifications cleared for user ${userId}`);
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