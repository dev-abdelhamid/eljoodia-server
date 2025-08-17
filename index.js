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
const inventoryRoutes = require('./routes/inventory'); // Fixed casing to match convention
const salesRoutes = require('./routes/sales');
const notificationsRoutes = require('./routes/notifications');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
  'https://eljoodia-server-production.up.railway.app',
];

// CORS configuration
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

// Socket.IO configuration
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

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.error(`[${new Date().toISOString()}] Socket authentication error: No token provided for socket ${socket.id}`);
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const cleanedToken = token.replace(/^Bearer\s+/i, '');
    const decoded = jwt.verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
    const user = await require('./models/User')
      .findById(decoded.id)
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();
    if (!user) {
      console.error(`[${new Date().toISOString()}] Socket authentication error: User not found for ID ${decoded.id}`);
      return next(new Error('Authentication error: User not found'));
    }
    socket.user = {
      _id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      branchId: decoded.branchId || null,
      branchName: user.branch?.name || null,
      departmentId: decoded.departmentId || null,
      departmentName: user.department?.name || null,
    };
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Socket authentication error: ${err.message}`);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] User connected: ${socket.id}, User: ${socket.user.username}`);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId, userId }) => {
    const rooms = [];
    if (role === 'admin') rooms.push('admin');
    if (role === 'branch' && branchId) rooms.push(`branch:${branchId}`);
    if (role === 'production' && departmentId) rooms.push(`department:${departmentId}`);
    if (role === 'chef' && chefId) rooms.push(`chef:${chefId}`);
    if (userId) rooms.push(`user:${userId}`);
    rooms.forEach((room) => socket.join(room));
    console.log(`[${new Date().toISOString()}] User ${socket.user._id} joined rooms:`, rooms);
  });

  socket.on('orderCreated', async (data) => {
    const rooms = ['admin', 'production'];
    if (data.branchId) rooms.push(`branch:${data.branchId}`);
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
      departments.forEach((departmentId) => rooms.push(`department:${departmentId}`));
    }
    rooms.forEach((room) => io.to(room).emit('orderCreated', data));
    console.log(`[${new Date().toISOString()}] orderCreated emitted to rooms:`, rooms);
  });

  socket.on('taskAssigned', async (data) => {
    const rooms = ['admin', 'production'];
    if (data.chef) rooms.push(`chef:${data.chef}`);
    if (data.order?.branch) rooms.push(`branch:${data.order.branch}`);
    if (data.product?.department?._id) rooms.push(`department:${data.product.department._id}`);
    rooms.forEach((room) => io.to(room).emit('taskAssigned', data));
    console.log(`[${new Date().toISOString()}] taskAssigned emitted to rooms:`, rooms);
  });

  socket.on('taskStatusUpdated', async ({ taskId, status, orderId }) => {
    const rooms = ['admin', 'production'];
    try {
      const order = await require('./models/Order').findById(orderId).lean();
      if (order?.branch) rooms.push(`branch:${order.branch}`);
      rooms.forEach((room) => io.to(room).emit('taskStatusUpdated', { taskId, status, orderId }));
      console.log(`[${new Date().toISOString()}] taskStatusUpdated emitted to rooms:`, rooms);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting taskStatusUpdated: ${err.message}`);
    }
  });

  socket.on('taskCompleted', async (data) => {
    const rooms = ['admin', 'production'];
    if (data.chef) rooms.push(`chef:${data.chef}`);
    if (data.orderId) {
      try {
        const order = await require('./models/Order').findById(data.orderId).lean();
        if (order?.branch) rooms.push(`branch:${order.branch}`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error fetching order for taskCompleted: ${err.message}`);
      }
    }
    rooms.forEach((room) => io.to(room).emit('taskCompleted', data));
    console.log(`[${new Date().toISOString()}] taskCompleted emitted to rooms:`, rooms);
  });

  socket.on('orderStatusUpdated', async ({ orderId, status }) => {
    const rooms = ['admin', 'production'];
    try {
      const order = await require('./models/Order').findById(orderId).lean();
      if (order?.branch) rooms.push(`branch:${order.branch}`);
      rooms.forEach((room) => io.to(room).emit('orderStatusUpdated', { orderId, status }));
      if (status === 'completed') io.to('admin').emit('orderCompleted', { orderId });
      console.log(`[${new Date().toISOString()}] orderStatusUpdated emitted to rooms:`, rooms);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting orderStatusUpdated: ${err.message}`);
    }
  });

  socket.on('returnStatusUpdated', async ({ returnId, status, returnNote }) => {
    const rooms = ['admin', 'production'];
    try {
      const returnRequest = await require('./models/Return').findById(returnId).lean();
      if (returnRequest?.order?.branch) rooms.push(`branch:${returnRequest.order.branch}`);
      rooms.forEach((room) => io.to(room).emit('returnStatusUpdated', { returnId, status, returnNote }));
      console.log(`[${new Date().toISOString()}] returnStatusUpdated emitted to rooms:`, rooms);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting returnStatusUpdated: ${err.message}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${new Date().toISOString()}] User disconnected: ${socket.id}, Reason: ${reason}`);
  });
});

// Connect to MongoDB
connectDB().catch((err) => {
  console.error(`[${new Date().toISOString()}] Failed to connect to MongoDB: ${err.message}`);
  process.exit(1);
});

// Middleware
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
    },
  })
);

// Allow Socket.IO route
app.use('/socket.io', (req, res, next) => next());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);

if (compression) app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Attach Socket.IO to app for controllers
app.set('io', io);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/chefs', chefRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/inventory', inventoryRoutes); // Fixed casing
app.use('/api/sales', salesRoutes);
app.use('/api/notifications', notificationsRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'production',
    time: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error: ${err.message}, Stack: ${err.stack}`);
  res.status(err.status || 500).json({
    message: err.message || 'Internal Server Error',
    status: err.status || 500,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
});
