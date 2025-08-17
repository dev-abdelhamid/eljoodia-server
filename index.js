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
const returnRoutes = require('./routes/returns');
const inventoryRoutes = require('./routes/inventory');
const salesRoutes = require('./routes/sales');
const notificationsRoutes = require('./routes/notifications');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
  'https://eljoodia-server-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error(`CORS error at ${new Date().toISOString()}: Origin ${origin} not allowed`);
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

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.error(`No token provided for socket at ${new Date().toISOString()}: ${socket.id}`);
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
      console.error(`User not found for socket at ${new Date().toISOString()}: ${decoded.id}`);
      return next(new Error('Authentication error: User not found'));
    }
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
    console.error(`Socket authentication error at ${new Date().toISOString()}: ${err.message}`);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

io.on('connection', (socket) => {
  console.log(`User connected at ${new Date().toISOString()}: ${socket.id}, User: ${socket.user.username}`);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId, userId }) => {
    if (role === 'admin') socket.join('admin');
    if (role === 'branch' && branchId) socket.join(`branch-${branchId}`);
    if (role === 'production') socket.join('production');
    if (role === 'chef' && chefId) socket.join(`chef-${chefId}`);
    if (role === 'production' && departmentId) socket.join(`department-${departmentId}`);
    if (userId) socket.join(`user-${userId}`);
    console.log(`User ${socket.user.id} joined rooms:`, { role, branchId, chefId, departmentId, userId });
  });

  socket.on('orderCreated', (data) => {
    io.to('admin').emit('orderCreated', data);
    io.to('production').emit('orderCreated', data);
    if (data.branchId) io.to(`branch-${data.branchId}`).emit('orderCreated', data);
    if (data.items?.length) {
      const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
      departments.forEach((departmentId) => {
        io.to(`department-${departmentId}`).emit('orderCreated', data);
      });
    }
  });

  socket.on('taskAssigned', (data) => {
    io.to('admin').emit('taskAssigned', data);
    io.to('production').emit('taskAssigned', data);
    if (data.chef) io.to(`chef-${data.chef}`).emit('taskAssigned', data);
    if (data.order?.branch) io.to(`branch-${data.order.branch}`).emit('taskAssigned', data);
    if (data.product?.department?._id) io.to(`department-${data.product.department._id}`).emit('taskAssigned', data);
  });

  socket.on('taskStatusUpdated', ({ taskId, status, orderId }) => {
    io.to('admin').emit('taskStatusUpdated', { taskId, status, orderId });
    io.to('production').emit('taskStatusUpdated', { taskId, status, orderId });
    if (orderId) {
      require('./models/Order').findById(orderId).then((order) => {
        if (order?.branch) {
          io.to(`branch-${order.branch}`).emit('taskStatusUpdated', { taskId, status, orderId });
        }
      });
    }
  });

  socket.on('taskCompleted', (data) => {
    io.to('admin').emit('taskCompleted', data);
    io.to('production').emit('taskCompleted', data);
    if (data.chef) io.to(`chef-${data.chef}`).emit('taskCompleted', data);
    if (data.orderId) {
      require('./models/Order').findById(data.orderId).then((order) => {
        if (order?.branch) io.to(`branch-${order.branch}`).emit('taskCompleted', data);
      });
    }
  });

  socket.on('orderStatusUpdated', ({ orderId, status }) => {
    io.to('admin').emit('orderStatusUpdated', { orderId, status });
    io.to('production').emit('orderStatusUpdated', { orderId, status });
    require('./models/Order').findById(orderId).then((order) => {
      if (order?.branch) io.to(`branch-${order.branch}`).emit('orderStatusUpdated', { orderId, status });
    });
    if (status === 'completed') io.to('admin').emit('orderCompleted', { orderId });
  });

  socket.on('returnStatusUpdated', ({ returnId, status, returnNote }) => {
    io.to('admin').emit('returnStatusUpdated', { returnId, status, returnNote });
    io.to('production').emit('returnStatusUpdated', { returnId, status, returnNote });
    require('./models/Return').findById(returnId).then((returnRequest) => {
      if (returnRequest?.order?.branch) {
        io.to(`branch-${returnRequest.order.branch}`).emit('returnStatusUpdated', { returnId, status, returnNote });
      }
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected at ${new Date().toISOString()}: ${socket.id}, Reason: ${reason}`);
  });
});

connectDB().catch((err) => {
  console.error(`Failed to connect to MongoDB at ${new Date().toISOString()}: ${err.message}`);
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

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'production', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
});