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
  path: '/api/socket.io',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
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
      branchId: user.branch?._id || null,
      branchName: user.branch?.name,
      departmentId: user.department?._id || null,
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
    if (role === 'branch' && branchId) {
      socket.join(`branch-${branchId}`);
      rooms.push(`branch-${branchId}`);
    }
    if (role === 'production' && departmentId) {
      socket.join(`department-${departmentId}`);
      rooms.push(`department-${departmentId}`);
    }
    if (role === 'chef' && chefId) {
      socket.join(`chef-${chefId}`);
      rooms.push(`chef-${chefId}`);
    }
    if (userId) {
      socket.join(`user-${userId}`);
      rooms.push(`user-${userId}`);
    }
    console.log(`[${new Date().toISOString()}] User ${socket.user.username} (${socket.user.id}) joined rooms: ${rooms.join(', ')}`);
  });

  socket.on('orderCreated', async (data) => {
    const eventData = { ...data, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    if (data.branchId) rooms.push(`branch-${data.branchId}`);
    const departments = [...new Set(data.items?.map((item) => item.department?._id).filter(Boolean))];
    departments.forEach((departmentId) => rooms.push(`department-${departmentId}`));

    const users = await require('./models/User').find({
      $or: [
        { role: 'admin' },
        { role: 'production', department: { $in: departments } },
        { role: 'branch', branch: data.branchId },
      ],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'order_created',
        `New order #${data.orderNumber} created`,
        { orderId: data._id, branchId: data.branchId },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('orderCreated', eventData));
  });

  socket.on('orderApproved', async (data) => {
    const eventData = { ...data, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    if (data.branchId) rooms.push(`branch-${data.branchId}`);

    const users = await require('./models/User').find({
      $or: [{ role: 'admin' }, { role: 'branch', branch: data.branchId }],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'order_approved',
        `Order #${data.orderNumber} approved`,
        { orderId: data._id, branchId: data.branchId },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('orderApproved', eventData));
  });

  socket.on('taskAssigned', async (data) => {
    const eventData = { ...data, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    if (data.chef) rooms.push(`chef-${data.chef}`);
    if (data.order?.branch) rooms.push(`branch-${data.order.branch}`);
    if (data.product?.department?._id) rooms.push(`department-${data.product.department._id}`);

    const users = await require('./models/User').find({
      $or: [
        { role: 'admin' },
        { role: 'production', department: data.product?.department?._id },
        { role: 'branch', branch: data.order?.branch },
        { _id: data.chef },
      ],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'task_assigned',
        `Task assigned for product ${data.product?.name || 'Unknown'}`,
        { orderId: data.orderId, taskId: data._id, branchId: data.order?.branch },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('taskAssigned', eventData));
  });

  socket.on('taskStatusUpdated', async ({ taskId, status, orderId, itemId }) => {
    const eventData = { taskId, status, orderId, itemId, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    const order = await require('./models/Order').findById(orderId).lean();
    if (order?.branch) rooms.push(`branch-${order.branch}`);

    const users = await require('./models/User').find({
      $or: [{ role: 'admin' }, { role: 'branch', branch: order?.branch }],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'task_status_updated',
        `Task ${taskId} status updated to ${status}`,
        { taskId, orderId, itemId, branchId: order?.branch },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('taskStatusUpdated', eventData));
  });

  socket.on('taskCompleted', async (data) => {
    const eventData = { ...data, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    if (data.chef) rooms.push(`chef-${data.chef}`);
    const order = await require('./models/Order').findById(data.orderId).lean();
    if (order?.branch) rooms.push(`branch-${order.branch}`);

    const users = await require('./models/User').find({
      $or: [{ role: 'admin' }, { role: 'branch', branch: order?.branch }, { _id: data.chef }],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'task_completed',
        `Task for order ${data.orderId} completed`,
        { orderId: data.orderId, taskId: data._id, branchId: order?.branch },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('taskCompleted', eventData));
  });

  socket.on('orderStatusUpdated', async ({ orderId, status, user }) => {
    const order = await require('./models/Order').findById(orderId).populate('branch', 'name').lean();
    const eventData = { orderId, status, user, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    if (order?.branch) rooms.push(`branch-${order.branch._id}`);

    const users = await require('./models/User').find({
      $or: [{ role: 'admin' }, { role: 'branch', branch: order?.branch?._id }],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'order_status_updated',
        `Order #${order.orderNumber} status updated to ${status}`,
        { orderId, branchId: order?.branch?._id },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('orderStatusUpdated', eventData));

    if (status === 'completed' && order) {
      const completedEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/notification.mp3',
      };
      for (const user of users) {
        await createNotification(
          user._id,
          'order_completed',
          `Order #${order.orderNumber} completed`,
          { orderId, branchId: order.branch._id },
          io
        );
      }
      rooms.forEach((room) => apiNamespace.to(room).emit('orderCompleted', completedEventData));
    }

    if (status === 'in_transit' && order) {
      const transitEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        transitStartedAt: new Date().toISOString(),
        sound: '/notification.mp3',
      };
      for (const user of users) {
        await createNotification(
          user._id,
          'order_in_transit',
          `Order #${order.orderNumber} in transit`,
          { orderId, branchId: order.branch._id },
          io
        );
      }
      rooms.forEach((room) => apiNamespace.to(room).emit('orderInTransit', transitEventData));
    }

    if (status === 'delivered' && order) {
      const deliveredEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch._id,
        branchName: order.branch.name || 'Unknown',
        deliveredAt: new Date().toISOString(),
        sound: '/notification.mp3',
      };
      for (const user of users) {
        await createNotification(
          user._id,
          'order_delivered',
          `Order #${order.orderNumber} delivered`,
          { orderId, branchId: order.branch._id },
          io
        );
      }
      rooms.forEach((room) => apiNamespace.to(room).emit('orderDelivered', deliveredEventData));
    }
  });

  socket.on('returnStatusUpdated', async ({ returnId, status, branchId, reviewNotes, returnNumber }) => {
    const returnRequest = await require('./models/Return').findById(returnId).populate('order', 'branch orderNumber').lean();
    const eventData = { returnId, status, branchId, reviewNotes, returnNumber, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    if (returnRequest?.order?.branch) rooms.push(`branch-${returnRequest.order.branch}`);

    const users = await require('./models/User').find({
      $or: [
        { role: 'admin' },
        { role: 'production' },
        { role: 'branch', branch: returnRequest?.order?.branch },
      ],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'return_status_updated',
        `Return #${returnRequest.returnNumber} status updated to ${status}`,
        { returnId, orderId: returnRequest.order?._id, branchId: returnRequest.order?.branch },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('returnStatusUpdated', eventData));

    if (status === 'approved') {
      apiNamespace.to(`branch-${branchId}`).emit('inventoryUpdated', { branchId });
    }
  });

  socket.on('missingAssignments', async (data) => {
    const eventData = { ...data, sound: '/notification.mp3' };
    const rooms = ['admin', 'production'];
    const order = await require('./models/Order').findById(data.orderId).lean();
    if (order?.branch) rooms.push(`branch-${order.branch}`);

    const users = await require('./models/User').find({
      $or: [{ role: 'admin' }, { role: 'production' }, { role: 'branch', branch: order?.branch }],
    }).lean();
    for (const user of users) {
      await createNotification(
        user._id,
        'missing_assignments',
        `Missing assignments for product ${data.productName} in order ${data.orderId}`,
        { orderId: data.orderId, itemId: data.itemId, branchId: order?.branch },
        io
      );
    }

    rooms.forEach((room) => apiNamespace.to(room).emit('missingAssignments', eventData));
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
      mediaSrc: ["'self'"],
    },
  })
);

app.use('/api/socket.io', (req, res, next) => next());

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