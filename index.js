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
const productionRoutes = require('./routes/production');

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
      mediaSrc: ["'self'", 'https://eljoodia.vercel.app'],
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
app.use('/api/production', productionRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'production', time: new Date().toISOString() });
});

const baseUrl = process.env.CLIENT_URL || 'https://eljoodia.vercel.app';

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

  socket.on('orderCreated', async (data) => {
    const order = await require('./models/Order').findById(data._id).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      ...data,
      branchId: order.branch?._id?.toString(),
      branchName: order.branch?.name || 'Unknown',
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [300, 100, 300],
    };
    const rooms = ['admin', 'production', `branch-${order.branch?._id}`];
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
      departments.forEach((departmentId) => rooms.push(`department-${departmentId}`));
    }
    apiNamespace.to(rooms).emit('newNotification', eventData);
    if (data.userId) {
      await require('./utils/notifications').createNotification(
        data.userId,
        'order_created',
        `New order created: ${data.orderNumber}`,
        { ...data, branchId: order.branch?._id },
        io
      );
    }
  });

  socket.on('orderApproved', async (data) => {
    const order = await require('./models/Order').findById(data.orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      ...data,
      branchId: order.branch?._id?.toString(),
      branchName: order.branch?.name || 'Unknown',
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [200, 100, 200],
    };
    apiNamespace.to(['admin', 'production', `branch-${order.branch?._id}`]).emit('newNotification', eventData);
    if (data.userId) {
      await require('./utils/notifications').createNotification(
        data.userId,
        'order_approved',
        `Order ${data.orderNumber} approved`,
        { ...data, branchId: order.branch?._id },
        io
      );
    }
  });

  socket.on('taskAssigned', async (data) => {
    const order = await require('./models/Order').findById(data.order?._id).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      ...data,
      branchId: order.branch?._id?.toString(),
      branchName: order.branch?.name || 'Unknown',
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [400, 100, 400],
    };
    const rooms = ['admin', 'production', `branch-${order.branch?._id}`];
    if (data.chef) rooms.push(`chef-${data.chef}`);
    if (data.product?.department?._id) rooms.push(`department-${data.product.department._id}`);
    apiNamespace.to(rooms).emit('newNotification', eventData);
    if (data.userId) {
      await require('./utils/notifications').createNotification(
        data.userId,
        'task_assigned',
        `Task assigned for order ${data.order?.orderNumber}`,
        { ...data, branchId: order.branch?._id },
        io
      );
    }
  });

  socket.on('taskStatusUpdated', async (data) => {
    const order = await require('./models/Order').findById(data.orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      ...data,
      branchId: order.branch?._id?.toString(),
      branchName: order.branch?.name || 'Unknown',
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [200, 100, 200],
    };
    apiNamespace.to(['admin', 'production', `branch-${order.branch?._id}`]).emit('newNotification', eventData);
    if (data.userId) {
      await require('./utils/notifications').createNotification(
        data.userId,
        'task_status_updated',
        `Task status updated to ${data.status} for order ${data.orderId}`,
        { ...data, branchId: order.branch?._id },
        io
      );
    }
  });

  socket.on('taskCompleted', async (data) => {
    const order = await require('./models/Order').findById(data.orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      ...data,
      branchId: order.branch?._id?.toString(),
      branchName: order.branch?.name || 'Unknown',
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [200, 100, 200],
    };
    const rooms = ['admin', 'production', `branch-${order.branch?._id}`];
    if (data.chef) rooms.push(`chef-${data.chef}`);
    apiNamespace.to(rooms).emit('newNotification', eventData);
    if (data.userId) {
      await require('./utils/notifications').createNotification(
        data.userId,
        'task_completed',
        `Task completed for order ${data.orderId}`,
        { ...data, branchId: order.branch?._id },
        io
      );
    }
  });

  socket.on('orderStatusUpdated', async (data) => {
    const order = await require('./models/Order').findById(data.orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      ...data,
      branchId: order.branch?._id?.toString(),
      branchName: order.branch?.name || 'Unknown',
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [200, 100, 200],
    };
    const rooms = ['admin', 'production', `branch-${order.branch?._id}`];
    apiNamespace.to(rooms).emit('newNotification', eventData);
    if (data.user?.id) {
      await require('./utils/notifications').createNotification(
        data.user.id,
        'order_status_updated',
        `Order ${data.orderNumber} status updated to ${data.status}`,
        { ...data, branchId: order.branch?._id },
        io
      );
    }
    if (data.status === 'completed') {
      const completedEventData = {
        orderId: data.orderId,
        orderNumber: data.orderNumber,
        branchId: order.branch?._id?.toString(),
        branchName: order.branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: `${baseUrl}/sounds/notification.mp3`,
        vibrate: [300, 100, 300],
      };
      apiNamespace.to(['admin', 'production', `branch-${order.branch?._id}`]).emit('newNotification', completedEventData);
      if (data.user?.id) {
        await require('./utils/notifications').createNotification(
          data.user.id,
          'order_completed',
          `Order ${data.orderNumber} completed`,
          completedEventData,
          io
        );
      }
    }
    if (data.status === 'in_transit') {
      const transitEventData = {
        orderId: data.orderId,
        orderNumber: data.orderNumber,
        branchId: order.branch?._id?.toString(),
        branchName: order.branch?.name || 'Unknown',
        transitStartedAt: new Date().toISOString(),
        sound: `${baseUrl}/sounds/notification.mp3`,
        vibrate: [300, 100, 300],
      };
      apiNamespace.to(['admin', 'production', `branch-${order.branch?._id}`]).emit('newNotification', transitEventData);
      if (data.user?.id) {
        await require('./utils/notifications').createNotification(
          data.user.id,
          'order_in_transit',
          `Order ${data.orderNumber} is in transit`,
          transitEventData,
          io
        );
      }
    }
    if (data.status === 'delivered') {
      const deliveredEventData = {
        orderId: data.orderId,
        orderNumber: data.orderNumber,
        branchId: order.branch?._id?.toString(),
        branchName: order.branch?.name || 'Unknown',
        deliveredAt: new Date().toISOString(),
        sound: `${baseUrl}/sounds/notification.mp3`,
        vibrate: [300, 100, 300],
      };
      apiNamespace.to(['admin', 'production', `branch-${order.branch?._id}`]).emit('newNotification', deliveredEventData);
      if (data.user?.id) {
        await require('./utils/notifications').createNotification(
          data.user.id,
          'order_delivered',
          `Order ${data.orderNumber} delivered`,
          deliveredEventData,
          io
        );
      }
    }
  });

  socket.on('returnStatusUpdated', async (data) => {
    const returnRequest = await require('./models/Return').findById(data.returnId).populate('order').lean();
    if (!returnRequest) return;
    const eventData = {
      ...data,
      branchId: returnRequest.order?.branch?.toString(),
      orderNumber: returnRequest.order?.orderNumber,
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [200, 100, 200],
    };
    apiNamespace.to(['admin', 'production', `branch-${returnRequest.order?.branch}`]).emit('newNotification', eventData);
    if (data.userId) {
      await require('./utils/notifications').createNotification(
        data.userId,
        'return_status_updated',
        `Return ${data.returnId} status updated to ${data.status}`,
        { ...data, branchId: returnRequest.order?.branch },
        io
      );
    }
  });

  socket.on('missingAssignments', async (data) => {
    const order = await require('./models/Order').findById(data.orderId).populate('branch', 'name').lean();
    if (!order) return;
    const eventData = {
      ...data,
      branchId: order.branch?._id?.toString(),
      branchName: order.branch?.name || 'Unknown',
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [400, 100, 400],
    };
    apiNamespace.to(['admin', 'production', `branch-${order.branch?._id}`]).emit('newNotification', eventData);
    if (data.userId) {
      await require('./utils/notifications').createNotification(
        data.userId,
        'missing_assignments',
        `Missing assignments for order ${data.orderId}`,
        { ...data, branchId: order.branch?._id },
        io
      );
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