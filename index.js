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
  console.warn('Compression module not found. Skipping compression middleware.');
}

const connectDB = require('./config/database');
const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const productRoutes = require('./routes/products');
const branchRoutes = require('./routes/branches');
const chefRoutes = require('./routes/chefs');
const departmentRoutes = require('./routes/departments');
const productionAssignmentRoutes = require('./routes/ProductionAssignment');
const returnRoutes = require('./routes/returns');
const inventoryRoutes = require('./routes/Inventory');
const salesRoutes = require('./routes/sales');

const app = express();
const server = http.createServer(app);

// تعيين الأصول المسموح بها
const allowedOrigins = [
  process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
  'http://localhost:3000',
  'https://eljoodia-server-production.up.railway.app',
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

// تهيئة Socket.io
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

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.error(`No token provided for socket at ${new Date().toISOString()}:`, socket.id);
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const cleanedToken = token.replace('Bearer ', '');
    const decoded = await jwt.verify(cleanedToken, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    console.error(`Invalid token at ${new Date().toISOString()}:`, {
      token: token.substring(0, 10) + '...',
      error: err.message,
    });
    next(new Error('Authentication error: Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`User connected at ${new Date().toISOString()}:`, socket.id, 'User:', socket.user?.id);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId }) => {
    if (role === 'admin') socket.join('admin');
    if (role === 'branch' && branchId) socket.join(`branch-${branchId}`);
    if (role === 'production') socket.join('production');
    if (role === 'chef' && chefId) socket.join(`chef-${chefId}`);
    if (role === 'production' && departmentId) socket.join(`department-${departmentId}`);
    console.log(`User ${socket.user?.id} joined rooms at ${new Date().toISOString()}:`, {
      role,
      branchId,
      chefId,
      departmentId,
    });
  });

  socket.on('orderCreated', (data) => {
    console.log(`Order created event at ${new Date().toISOString()}:`, data.orderId);
    if (socket.user.role === 'admin') {
      io.to('admin').emit('orderCreated', data);
    } else if (socket.user.role === 'production' && data.items) {
      const departmentId = socket.user.department?._id;
      if (departmentId && data.items.some((item) => item.department?._id === departmentId)) {
        io.to(`department-${departmentId}`).emit('orderCreated', data);
      }
    }
  });

  socket.on('taskAssigned', (data) => {
    console.log(`Task assigned event at ${new Date().toISOString()}:`, data.taskId);
    if (socket.user.role === 'admin') {
      io.to('admin').emit('taskAssigned', data);
    } else if (socket.user.role === 'production' && data.product?.department?._id) {
      io.to(`department-${data.product.department._id}`).emit('taskAssigned', data);
    }
  });

  socket.on('taskStatusUpdated', ({ taskId, status, orderId }) => {
    console.log(`Task status updated at ${new Date().toISOString()}:`, { taskId, status, orderId });
    io.to('admin').to('production').emit('taskStatusUpdated', { taskId, status, orderId });
  });

  socket.on('taskCompleted', (data) => {
    console.log(`Task completed event at ${new Date().toISOString()}:`, data.taskId);
    if (['admin', 'production'].includes(socket.user.role)) {
      io.to('admin').to('production').emit('taskCompleted', data);
    }
  });

  socket.on('orderStatusUpdated', ({ orderId, status }) => {
    console.log(`Order status updated at ${new Date().toISOString()}:`, { orderId, status });
    io.to('admin').to('production').emit('orderStatusUpdated', { orderId, status });
    if (status === 'completed') {
      io.to('admin').emit('orderCompleted', { orderId });
    }
  });

  socket.on('returnStatusUpdated', ({ returnId, status, returnNote }) => {
    console.log(`Return status updated at ${new Date().toISOString()}:`, { returnId, status });
    io.to('admin').to('production').emit('returnStatusUpdated', { returnId, status, returnNote });
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected at ${new Date().toISOString()}:`, socket.id, 'Reason:', reason, 'User:', socket.user?.id);
  });
});

connectDB().catch((err) => {
  console.error(`MongoDB connection failed at ${new Date().toISOString()}:`, err);
  process.exit(1);
});

app.use(helmet());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);
if (compression) app.use(compression());
else console.log('Running without compression middleware');
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
app.use('/api/production-assignments', productionAssignmentRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales', salesRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'development', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
});