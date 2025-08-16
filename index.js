const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const http = require('http');
const retry = require('async-retry');
const connectDB = require('./config/database');
const authRoutes = require('./routes/authRoutes');
const orderRoutes = require('./routes/orderRoutes');
const productRoutes = require('./routes/productRoutes');
const branchRoutes = require('./routes/branchRoutes');
const chefRoutes = require('./routes/chefRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const productionAssignmentsRoutes = require('./routes/productionAssignmentsRoutes');
const returnRoutes = require('./routes/returnRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const salesRoutes = require('./routes/salesRoutes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
});

// Environment validation
const { cleanEnv, str, port } = require('envalid');
const env = cleanEnv(process.env, {
  CLIENT_URL: str({ default: 'https://eljoodia.vercel.app' }),
  PORT: port({ default: 3000 }),
  JWT_SECRET: str(),
  MONGODB_URI: str(),
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: env.CLIENT_URL,
  credentials: true,
}));
app.use(express.json());
app.use(morgan('combined'));
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: 'تم تجاوز الحد الأقصى للطلبات، حاول مرة أخرى لاحقًا',
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'تم تجاوز الحد الأقصى لمحاولات تسجيل الدخول، حاول مرة أخرى لاحقًا',
});
app.use(limiter);
app.use('/api/auth', authLimiter, authRoutes);

// Routes
app.use('/api/orders', orderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/chefs', chefRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/production-assignments', productionAssignmentsRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales', salesRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
  });
});

// Socket.IO Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const user = jwt.verify(token, env.JWT_SECRET);
    socket.request.user = user;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

// Socket.IO Events
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('joinRoom', ({ role, branchId, chefId }) => {
    const user = socket.request.user;
    if (user.role !== role) {
      socket.emit('error', { message: 'دور غير مصرح به' });
      return;
    }
    if (role === 'admin') socket.join('admin');
    if (role === 'branch' && branchId && user.branchId === branchId) socket.join(`branch-${branchId}`);
    if (role === 'production') socket.join('production');
    if (role === 'chef' && chefId && user.chefId === chefId) socket.join(`chef-${chefId}`);
    console.log(`User joined rooms: role=${role}, branchId=${branchId}, chefId=${chefId}`);
  });

  socket.on('taskStatusUpdated', async ({ taskId, status }) => {
    try {
      const task = await mongoose.model('ProductionAssignment').findById(taskId);
      if (!task) return socket.emit('error', { message: 'المهمة غير موجودة' });

      const order = await mongoose.model('Order').findById(task.order);
      if (!order) return socket.emit('error', { message: 'الطلبية غير موجودة' });

      const allTasks = await mongoose.model('ProductionAssignment').find({ order: order._id });
      const allCompleted = allTasks.every(t => t.status === 'completed' || t._id.toString() === taskId && status === 'completed');

      if (allCompleted) {
        order.status = 'completed';
        await order.save();
        io.to('production').emit('orderCompleted', { orderId: order._id, status: 'completed' });
      }

      io.to('production').emit('taskStatusUpdated', { taskId, status });
      if (task.chef) io.to(`chef-${task.chef.user}`).emit('taskStatusUpdated', { taskId, status });
    } catch (err) {
      socket.emit('error', { message: 'خطأ في تحديث حالة المهمة' });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Start Server with MongoDB Retry
async function startServer() {
  await retry(
    async () => {
      await connectDB();
    },
    {
      retries: 5,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 5000,
      onRetry: (err) => console.warn('MongoDB connection attempt failed:', err),
    }
  );
  server.listen(env.PORT, () => console.log(`الخادم يعمل على المنفذ ${env.PORT}`));
}

startServer().catch((err) => {
  console.error('فشل تشغيل الخادم:', err);
  process.exit(1);
});