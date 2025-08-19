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
  console.warn(`[${new Date().toISOString()}] Compression module not found`);
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

app.use(cors({
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
  reconnectionAttempts: 15,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

const apiNamespace = io.of('/api');
apiNamespace.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error: No token provided'));
  try {
    const cleanedToken = token.replace('Bearer ', '');
    const decoded = jwt.verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
    const user = await require('./models/User').findById(decoded.id)
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();
    if (!user) return next(new Error('Authentication error: User not found'));
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
    console.error(`[${new Date().toISOString()}] Socket auth error: ${err.message}`);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

apiNamespace.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Connected: ${socket.id}, User: ${socket.user.username}`);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId, userId }) => {
    const rooms = [];
    if (role === 'admin') rooms.push('admin');
    if (role === 'branch' && branchId) rooms.push(`branch-${branchId}`);
    if (role === 'production') rooms.push('production');
    if (role === 'chef' && chefId) rooms.push(`chef-${chefId}`);
    if (role === 'production' && departmentId) rooms.push(`department-${departmentId}`);
    if (userId) rooms.push(`user-${userId}`);
    socket.join(rooms);
    console.log(`[${new Date().toISOString()}] User ${socket.user.username} joined: ${rooms.join(', ')}`);
  });

  socket.on('orderCreated', (data) => {
    const rooms = ['admin', 'production', data.branchId ? `branch-${data.branchId}` : null].filter(Boolean);
    const departments = [...new Set(data.items?.map(item => item.department?._id).filter(Boolean))];
    apiNamespace.to(rooms).emit('orderCreated', data);
    departments.forEach(dept => apiNamespace.to(`department-${dept}`).emit('orderCreated', data));
  });

  socket.on('taskAssigned', (data) => {
    const rooms = [
      'admin', 
      'production', 
      data.chef ? `chef-${data.chef}` : null, 
      data.order?.branch ? `branch-${data.order.branch}` : null,
      data.product?.department?._id ? `department-${data.product.department._id}` : null,
    ].filter(Boolean);
    apiNamespace.to(rooms).emit('taskAssigned', data);
  });

  socket.on('taskStatusUpdated', async ({ taskId, status, orderId, itemId }) => {
    const order = await require('./models/Order').findById(orderId).lean();
    const rooms = ['admin', 'production', order?.branch ? `branch-${order.branch}` : null].filter(Boolean);
    apiNamespace.to(rooms).emit('taskStatusUpdated', { taskId, status, orderId, itemId });
  });

  socket.on('taskCompleted', async (data) => {
    const order = await require('./models/Order').findById(data.orderId).lean();
    const rooms = [
      'admin', 
      'production', 
      data.chef ? `chef-${data.chef}` : null, 
      order?.branch ? `branch-${order.branch}` : null,
    ].filter(Boolean);
    apiNamespace.to(rooms).emit('taskCompleted', data);
  });

  socket.on('orderStatusUpdated', async ({ orderId, status, user }) => {
    const order = await require('./models/Order').findById(orderId).populate('branch', 'name').lean();
    const rooms = ['admin', 'production', order?.branch?._id ? `branch-${order.branch._id}` : null].filter(Boolean);
    apiNamespace.to(rooms).emit('orderStatusUpdated', { orderId, status, user });
    if (status === 'completed' && order) {
      const eventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
      };
      apiNamespace.to(rooms).emit('orderCompleted', eventData);
    }
  });

  socket.on('returnStatusUpdated', async ({ returnId, status, returnNote }) => {
    const returnRequest = await require('./models/Return').findById(returnId).lean();
    const rooms = ['admin', 'production', returnRequest?.order?.branch ? `branch-${returnRequest.order.branch}` : null].filter(Boolean);
    apiNamespace.to(rooms).emit('returnStatusUpdated', { returnId, status, returnNote });
  });

  socket.on('missingAssignments', async (data) => {
    const order = await require('./models/Order').findById(data.orderId).lean();
    const rooms = ['admin', 'production', order?.branch ? `branch-${order.branch}` : null].filter(Boolean);
    apiNamespace.to(rooms).emit('missingAssignments', data);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${new Date().toISOString()}] Disconnected: ${socket.id}, Reason: ${reason}`);
  });
});

connectDB().catch((err) => {
  console.error(`[${new Date().toISOString()}] MongoDB connection failed: ${err.message}`);
  process.exit(1);
});

app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    connectSrc: ["'self'", ...allowedOrigins.map(o => o.replace(/^https?/, 'wss')), ...allowedOrigins],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    mediaSrc: ["'self'", 'data:', ...allowedOrigins], // Allow audio sources
  },
}));

app.use('/socket.io', (req, res, next) => next());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests, please try again later',
}));

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] SIGTERM received. Closing server.`);
  server.close(() => {
    require('mongoose').connection.close(false, () => {
      console.log(`[${new Date().toISOString()}] MongoDB connection closed.`);
      process.exit(0);
    });
  });
});