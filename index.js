// index.js
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
const productionAssignmentRoutes = require('./routes/productionAssignments'); // تعديل الاسم ليكون متسق
const returnRoutes = require('./routes/returns');
const inventoryRoutes = require('./routes/inventory');
const salesRoutes = require('./routes/sales');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
  'https://eljoodia-server-production.up.railway.app',
  'http://localhost:3000',
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
  console.log(`تلقي التوكن في ${new Date().toISOString()}:`, token ? token.substring(0, 10) + '...' : 'ما فيش توكن');
  if (!token) {
    console.error(`ما فيش توكن مقدم للسوكت في ${new Date().toISOString()}:`, socket.id);
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const cleanedToken = token.startsWith('Bearer ') ? token.replace('Bearer ', '') : token;
    const decoded = await jwt.verify(cleanedToken, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    console.error(`توكن غير صالح في ${new Date().toISOString()}:`, {
      token: token.substring(0, 10) + '...',
      error: err.message,
    });
    next(new Error(`Authentication error: ${err.message}`));
  }
});

io.on('connection', (socket) => {
  console.log(`مستخدم متصل في ${new Date().toISOString()}:`, socket.id, 'User:', socket.user?.id);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId }) => {
    if (role === 'admin') socket.join('admin');
    if (role === 'branch' && branchId) socket.join(`branch-${branchId}`);
    if (role === 'production') socket.join('production');
    if (role === 'chef' && chefId) socket.join(`chef-${chefId}`);
    if (role === 'production' && departmentId) socket.join(`department-${departmentId}`);
    console.log(`انضم المستخدم ${socket.user?.id} إلى الغرف في ${new Date().toISOString()}:`, {
      role,
      branchId,
      chefId,
      departmentId,
    });
  });

  socket.on('orderCreated', (data) => {
    console.log(`حدث إنشاء طلب في ${new Date().toISOString()}:`, data.orderId);
    io.to('admin').emit('orderCreated', data);
    io.to('production').emit('orderCreated', data);
    if (data.branchId) {
      io.to(`branch-${data.branchId}`).emit('orderCreated', data);
    }
  });

  socket.on('taskAssigned', (data) => {
    console.log(`حدث تعيين مهمة في ${new Date().toISOString()}:`, data.taskId);
    io.to('admin').emit('taskAssigned', data);
    io.to('production').emit('taskAssigned', data);
    if (data.chef) {
      io.to(`chef-${data.chef}`).emit('taskAssigned', data);
    }
  });

  socket.on('taskStatusUpdated', ({ taskId, status, orderId }) => {
    console.log(`تحديث حالة المهمة في ${new Date().toISOString()}:`, { taskId, status, orderId });
    io.to('admin').to('production').emit('taskStatusUpdated', { taskId, status, orderId });
  });

  socket.on('taskCompleted', (data) => {
    console.log(`حدث إكمال مهمة في ${new Date().toISOString()}:`, data.taskId);
    io.to('admin').to('production').emit('taskCompleted', data);
    if (data.chef) {
      io.to(`chef-${data.chef}`).emit('taskCompleted', data);
    }
  });

  socket.on('orderStatusUpdated', ({ orderId, status }) => {
    console.log(`تحديث حالة الطلب في ${new Date().toISOString()}:`, { orderId, status });
    io.to('admin').to('production').emit('orderStatusUpdated', { orderId, status });
    if (data.branchId) {
      io.to(`branch-${data.branchId}`).emit('orderStatusUpdated', { orderId, status });
    }
  });

  socket.on('returnStatusUpdated', ({ returnId, status, returnNote }) => {
    console.log(`تحديث حالة الإرجاع في ${new Date().toISOString()}:`, { returnId, status });
    io.to('admin').to('production').emit('returnStatusUpdated', { returnId, status, returnNote });
  });

  socket.on('disconnect', (reason) => {
    console.log(`انقطع اتصال المستخدم في ${new Date().toISOString()}:`, socket.id, 'Reason:', reason, 'User:', socket.user?.id);
  });
});

connectDB().catch((err) => {
  console.error(`فشل الاتصال بـ MongoDB في ${new Date().toISOString()}:`, err);
  process.exit(1);
});

app.use(helmet());

app.use('/socket.io', (req, res, next) => next());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'طلبات كثيرة جدًا من هذا العنوان، حاول مرة أخرى بعد 15 دقيقة',
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
app.use('/api/production-assignments', productionAssignmentRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales', salesRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'development', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`السيرفر يعمل على المنفذ ${PORT} في ${new Date().toISOString()}`);
});