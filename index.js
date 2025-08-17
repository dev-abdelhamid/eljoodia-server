const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { sanitize } = require('express-mongo-sanitize');
const xss = require('xss-clean');
require('dotenv').config();

let compression;
try {
  compression = require('compression');
} catch (err) {
  console.warn('Compression module not found. Skipping compression middleware.');
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

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Configure allowed origins for CORS and Socket.IO
const allowedOrigins = [
  process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
  'https://eljoodia-server-production.up.railway.app',
];

// Initialize Socket.IO with CORS configuration
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error(`CORS error at ${new Date().toISOString()}: Origin ${origin} not allowed`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  pingTimeout: 20000,
  pingInterval: 25000,
});

// Middleware to attach Socket.IO instance to request object
app.set('io', io);

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    const error = new Error('Authentication error: No token provided');
    console.error(`No token provided for socket at ${new Date().toISOString()}: ${socket.id}`);
    return next(error);
  }
  try {
    const cleanedToken = token.startsWith('Bearer ') ? token.replace('Bearer ', '') : token;
    const decoded = jwt.verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
    const user = await require('./models/User').findById(decoded.id)
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();
    if (!user) {
      const error = new Error('Authentication error: User not found');
      console.error(`User not found for socket at ${new Date().toISOString()}: ${decoded.id}`);
      return next(error);
    }
    socket.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      branchId: decoded.branchId || null,
      branchName: user.branch?.name || null,
      departmentId: decoded.departmentId || null,
      departmentName: user.department?.name || null,
    };
    next();
  } catch (err) {
    console.error(`Socket authentication error at ${new Date().toISOString()}: ${err.message}`);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`User connected at ${new Date().toISOString()}: ${socket.id}, User: ${socket.user.username}`);

  // Handle room joining with validation
  socket.on('joinRoom', ({ role, branchId, chefId, departmentId, userId }) => {
    // Clear previous rooms to prevent duplicate joins
    socket.rooms.forEach((room) => {
      if (room !== socket.id) socket.leave(room);
    });

    // Join relevant rooms based on role and IDs
    const rooms = [];
    if (role === 'admin') rooms.push('admin');
    if (role === 'branch' && branchId) rooms.push(`branch-${branchId}`);
    if (role === 'production') rooms.push('production');
    if (role === 'chef' && chefId) rooms.push(`chef-${chefId}`);
    if (role === 'production' && departmentId) rooms.push(`department-${departmentId}`);
    if (userId) rooms.push(`user-${userId}`);

    rooms.forEach((room) => socket.join(room));
    console.log(`User ${socket.user.id} joined rooms: ${rooms.join(', ')}`, {
      role,
      branchId,
      chefId,
      departmentId,
      userId,
    });
  });

  // Handle order creation event
  socket.on('orderCreated', (data) => {
    if (!data.orderId || !data.branchId || !data.orderNumber) {
      console.error(`Invalid orderCreated data at ${new Date().toISOString()}:`, data);
      return;
    }
    io.to('admin').emit('orderCreated', data);
    io.to('production').emit('orderCreated', data);
    io.to(`branch-${data.branchId}`).emit('orderCreated', data);
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
      departments.forEach((departmentId) => {
        io.to(`department-${departmentId}`).emit('orderCreated', data);
      });
    }
    console.log(`Order created notification sent at ${new Date().toISOString()}:`, data);
  });

  // Handle task assignment event
  socket.on('taskAssigned', (data) => {
    if (!data.taskId || !data.orderId) {
      console.error(`Invalid taskAssigned data at ${new Date().toISOString()}:`, data);
      return;
    }
    io.to('admin').emit('taskAssigned', data);
    io.to('production').emit('taskAssigned', data);
    if (data.chef) io.to(`chef-${data.chef}`).emit('taskAssigned', data);
    if (data.order?.branch) io.to(`branch-${data.order.branch}`).emit('taskAssigned', data);
    if (data.product?.department?._id) io.to(`department-${data.product.department._id}`).emit('taskAssigned', data);
    console.log(`Task assigned notification sent at ${new Date().toISOString()}:`, data);
  });

  // Handle task status update event
  socket.on('taskStatusUpdated', async ({ taskId, status, orderId }) => {
    if (!taskId || !status || !orderId) {
      console.error(`Invalid taskStatusUpdated data at ${new Date().toISOString()}:`, { taskId, status, orderId });
      return;
    }
    io.to('admin').emit('taskStatusUpdated', { taskId, status, orderId });
    io.to('production').emit('taskStatusUpdated', { taskId, status, orderId });
    try {
      const order = await require('./models/Order').findById(orderId).lean();
      if (order?.branch) {
        io.to(`branch-${order.branch}`).emit('taskStatusUpdated', { taskId, status, orderId });
      }
    } catch (err) {
      console.error(`Error fetching order for taskStatusUpdated at ${new Date().toISOString()}: ${err.message}`);
    }
    console.log(`Task status updated notification sent at ${new Date().toISOString()}:`, { taskId, status, orderId });
  });

  // Handle task completion event
  socket.on('taskCompleted', async (data) => {
    if (!data.taskId || !data.orderId) {
      console.error(`Invalid taskCompleted data at ${new Date().toISOString()}:`, data);
      return;
    }
    io.to('admin').emit('taskCompleted', data);
    io.to('production').emit('taskCompleted', data);
    if (data.chef) io.to(`chef-${data.chef}`).emit('taskCompleted', data);
    try {
      const order = await require('./models/Order').findById(data.orderId).lean();
      if (order?.branch) io.to(`branch-${order.branch}`).emit('taskCompleted', data);
    } catch (err) {
      console.error(`Error fetching order for taskCompleted at ${new Date().toISOString()}: ${err.message}`);
    }
    console.log(`Task completed notification sent at ${new Date().toISOString()}:`, data);
  });

  // Handle order status update event
  socket.on('orderStatusUpdated', async ({ orderId, status }) => {
    if (!orderId || !status) {
      console.error(`Invalid orderStatusUpdated data at ${new Date().toISOString()}:`, { orderId, status });
      return;
    }
    io.to('admin').emit('orderStatusUpdated', { orderId, status });
    io.to('production').emit('orderStatusUpdated', { orderId, status });
    try {
      const order = await require('./models/Order').findById(orderId).lean();
      if (order?.branch) io.to(`branch-${order.branch}`).emit('orderStatusUpdated', { orderId, status });
      if (status === 'completed') io.to('admin').emit('orderCompleted', { orderId });
    } catch (err) {
      console.error(`Error fetching order for orderStatusUpdated at ${new Date().toISOString()}: ${err.message}`);
    }
    console.log(`Order status updated notification sent at ${new Date().toISOString()}:`, { orderId, status });
  });

  // Handle return status update event
  socket.on('returnStatusUpdated', async ({ returnId, status, returnNote }) => {
    if (!returnId || !status) {
      console.error(`Invalid returnStatusUpdated data at ${new Date().toISOString()}:`, { returnId, status });
      return;
    }
    io.to('admin').emit('returnStatusUpdated', { returnId, status, returnNote });
    io.to('production').emit('returnStatusUpdated', { returnId, status, returnNote });
    try {
      const returnRequest = await require('./models/Return').findById(returnId).lean();
      if (returnRequest?.order?.branch) {
        io.to(`branch-${returnRequest.order.branch}`).emit('returnStatusUpdated', { returnId, status, returnNote });
      }
    } catch (err) {
      console.error(`Error fetching return for returnStatusUpdated at ${new Date().toISOString()}: ${err.message}`);
    }
    console.log(`Return status updated notification sent at ${new Date().toISOString()}:`, { returnId, status });
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log(`User disconnected at ${new Date().toISOString()}: ${socket.id}, Reason: ${reason}`);
  });
});

// Connect to MongoDB
connectDB().catch((err) => {
  console.error(`Failed to connect to MongoDB at ${new Date().toISOString()}: ${err.message}`);
  process.exit(1);
});

// Middleware setup
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

// Allow Socket.IO endpoint to bypass helmet
app.use('/socket.io', (req, res, next) => next());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);

// Compression, logging, and JSON parsing
if (compression) app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Security middleware
app.use(sanitize()); // Prevent MongoDB injection
app.use(xss()); // Prevent XSS attacks

// API routes
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'production',
    time: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error(`Error at ${new Date().toISOString()}: ${err.stack}`);
  res.status(err.status || 500).json({
    message: err.message || 'Internal Server Error',
    status: err.status || 500,
  });
});

// Graceful shutdown
const gracefulShutdown = () => {
  console.log(`Shutting down server at ${new Date().toISOString()}`);
  server.close(() => {
    console.log(`HTTP server closed at ${new Date().toISOString()}`);
    io.close(() => {
      console.log(`Socket.IO server closed at ${new Date().toISOString()}`);
      process.exit(0);
    });
  });
};

// Handle process termination
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
});

// Export io for use in controllers
module.exports = { io };