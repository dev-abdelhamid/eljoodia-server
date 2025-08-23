const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

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
const inventoryRoutes = require('./routes/Inventory'); // تصحيح الحالة لتكون متسقة
const salesRoutes = require('./routes/sales');
const notificationsRoutes = require('./routes/notifications');
const { createNotification } = require('./utils/notifications');

const app = express();
const server = http.createServer(app);

// إعدادات CORS
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

// إعداد Socket.IO
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 25000,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

// إعداد Redis Adapter (اختياري)
if (process.env.REDIS_URL) {
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();
  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      console.log(`[${new Date().toISOString()}] Redis Adapter connected successfully`);
    })
    .catch((err) => {
      console.error(`[${new Date().toISOString()}] Failed to connect Redis Adapter: ${err.message}`);
    });
}

// إعدادات Helmet للأمان
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        ...allowedOrigins.map((origin) => origin.replace(/^https?/, 'wss')),
        ...allowedOrigins,
      ],
      scriptSrc: ["'self'", "'unsafe-inline'"], // السماح بـ inline scripts إذا لزم الأمر
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", 'https://eljoodia-server-production.up.railway.app'],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
    },
  })
);

// تقديم الملفات الثابتة
app.use('/sounds', express.static('public/sounds'));

// فضاء الأسماء لـ Socket.IO
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
      branchName: user.branch?.name || 'Unknown',
      departmentId: decoded.departmentId || user.department?._id?.toString() || null,
      departmentName: user.department?.name || 'Unknown',
    };
    console.log(`[${new Date().toISOString()}] Authenticated socket user: ${socket.user.username} (${socket.user.id})`);
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Socket auth error for /api namespace: ${err.message}`);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

// معالجة أحداث Socket.IO
apiNamespace.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Connected to /api namespace: ${socket.id}, User: ${socket.user.username}`);

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId, userId }) => {
    if (!userId || !role) {
      console.error(`[${new Date().toISOString()}] Invalid joinRoom data:`, { role, branchId, chefId, departmentId, userId });
      socket.emit('error', { message: 'Invalid joinRoom data' });
      return;
    }
    const rooms = [];
    if (role === 'admin') rooms.push('admin');
    if (role === 'production') rooms.push('production');
    if (role === 'branch' && branchId) rooms.push(`branch-${branchId}`);
    if (role === 'chef' && chefId) rooms.push(`chef-${chefId}`);
    if (departmentId) rooms.push(`department-${departmentId}`);
    if (userId) rooms.push(`user-${userId}`);
    socket.join(rooms);
    console.log(`[${new Date().toISOString()}] User ${socket.user.username} (${socket.user.id}) joined rooms: ${rooms.join(', ')}`);
  });

  socket.on('orderCreated', async (data) => {
    try {
      const eventData = { ...data, sound: '/notification.mp3', vibrate: [300, 100, 300] };
      apiNamespace.to('admin').emit('orderCreated', eventData);
      apiNamespace.to('production').emit('orderCreated', eventData);
      if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderCreated', eventData);
      if (data.items?.length) {
        const departments = [...new Set(data.items.map((item) => item.department?._id).filter(Boolean))];
        departments.forEach((departmentId) => {
          apiNamespace.to(`department-${departmentId}`).emit('orderCreated', {
            ...eventData,
            sound: '/order-created.mp3',
          });
        });
      }
      await createNotification({
        title: `طلب جديد: ${data.orderNumber || 'غير معروف'}`,
        message: `تم إنشاء طلب جديد لفرع ${data.branchName || 'غير معروف'}`,
        userId: socket.user.id,
        role: ['admin', 'production'],
        branchId: data.branchId,
        departmentIds: data.items?.map((item) => item.department?._id).filter(Boolean),
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting orderCreated: ${err.message}`);
    }
  });

  socket.on('orderApproved', async (data) => {
    try {
      const eventData = { ...data, sound: '/order-approved.mp3', vibrate: [200, 100, 200] };
      apiNamespace.to('admin').emit('orderApproved', eventData);
      apiNamespace.to('production').emit('orderApproved', eventData);
      if (data.branchId) apiNamespace.to(`branch-${data.branchId}`).emit('orderApproved', eventData);
      await createNotification({
        title: `تمت الموافقة على الطلب: ${data.orderNumber || 'غير معروف'}`,
        message: `تمت الموافقة على الطلب بواسطة ${socket.user.username}`,
        userId: socket.user.id,
        role: ['admin', 'production'],
        branchId: data.branchId,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting orderApproved: ${err.message}`);
    }
  });

  socket.on('taskAssigned', async (data) => {
    try {
      const eventData = { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] };
      apiNamespace.to('admin').emit('taskAssigned', eventData);
      apiNamespace.to('production').emit('taskAssigned', eventData);
      if (data.chef) apiNamespace.to(`chef-${data.chef}`).emit('taskAssigned', eventData);
      if (data.order?.branch) apiNamespace.to(`branch-${data.order.branch}`).emit('taskAssigned', eventData);
      if (data.product?.department?._id) apiNamespace.to(`department-${data.product.department._id}`).emit('taskAssigned', eventData);
      await createNotification({
        title: `مهمة جديدة مخصصة`,
        message: `تم تخصيص مهمة للطلب ${data.order?.orderNumber || 'غير معروف'} إلى الشيف ${data.chefName || 'غير معروف'}`,
        userId: socket.user.id,
        role: ['admin', 'production', 'chef'],
        chefId: data.chef,
        branchId: data.order?.branch,
        departmentId: data.product?.department?._id,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting taskAssigned: ${err.message}`);
    }
  });

  socket.on('taskStatusUpdated', async ({ taskId, status, orderId, itemId }) => {
    try {
      const eventData = { taskId, status, orderId, itemId, sound: '/notification.mp3', vibrate: [200, 100, 200] };
      apiNamespace.to('admin').emit('taskStatusUpdated', eventData);
      apiNamespace.to('production').emit('taskStatusUpdated', eventData);
      const order = await require('./models/Order').findById(orderId).lean();
      if (order?.branch) {
        apiNamespace.to(`branch-${order.branch}`).emit('taskStatusUpdated', eventData);
      }
      await createNotification({
        title: `تحديث حالة المهمة`,
        message: `تم تحديث حالة المهمة ${taskId} إلى ${status}`,
        userId: socket.user.id,
        role: ['admin', 'production'],
        branchId: order?.branch,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting taskStatusUpdated: ${err.message}`);
    }
  });

  socket.on('taskCompleted', async (data) => {
    try {
      const eventData = { ...data, sound: '/notification.mp3', vibrate: [200, 100, 200] };
      apiNamespace.to('admin').emit('taskCompleted', eventData);
      apiNamespace.to('production').emit('taskCompleted', eventData);
      if (data.chef) apiNamespace.to(`chef-${data.chef}`).emit('taskCompleted', eventData);
      const order = await require('./models/Order').findById(data.orderId).lean();
      if (order?.branch) {
        apiNamespace.to(`branch-${order.branch}`).emit('taskCompleted', eventData);
      }
      await createNotification({
        title: `اكتمال المهمة`,
        message: `تم إكمال المهمة للطلب ${data.order?.orderNumber || 'غير معروف'}`,
        userId: socket.user.id,
        role: ['admin', 'production', 'chef'],
        chefId: data.chef,
        branchId: order?.branch,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting taskCompleted: ${err.message}`);
    }
  });

  socket.on('orderStatusUpdated', async ({ orderId, status, user }) => {
    try {
      const order = await require('./models/Order').findById(orderId).populate('branch', 'name').lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found for orderStatusUpdated: ${orderId}`);
        return;
      }
      const eventData = { orderId, status, user, sound: '/status-updated.mp3', vibrate: [200, 100, 200] };
      apiNamespace.to('admin').emit('orderStatusUpdated', eventData);
      apiNamespace.to('production').emit('orderStatusUpdated', eventData);
      if (order.branch) {
        apiNamespace.to(`branch-${order.branch._id}`).emit('orderStatusUpdated', eventData);
      }
      await createNotification({
        title: `تحديث حالة الطلب`,
        message: `تم تحديث حالة الطلب ${order.orderNumber || 'غير معروف'} إلى ${status}`,
        userId: socket.user.id,
        role: ['admin', 'production'],
        branchId: order.branch?._id,
      });

      if (status === 'completed') {
        const completedEventData = {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch._id,
          branchName: order.branch.name || 'Unknown',
          completedAt: new Date().toISOString(),
          sound: '/notification.mp3',
          vibrate: [300, 100, 300],
        };
        apiNamespace.to('admin').emit('orderCompleted', completedEventData);
        apiNamespace.to('production').emit('orderCompleted', completedEventData);
        if (order.branch) {
          apiNamespace.to(`branch-${order.branch._id}`).emit('orderCompleted', completedEventData);
        }
        await createNotification({
          title: `اكتمال الطلب`,
          message: `تم إكمال الطلب ${order.orderNumber} لفرع ${order.branch.name || 'غير معروف'}`,
          userId: socket.user.id,
          role: ['admin', 'production'],
          branchId: order.branch._id,
        });
      }
      if (status === 'in_transit') {
        const transitEventData = {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch._id,
          branchName: order.branch.name || 'Unknown',
          transitStartedAt: new Date().toISOString(),
          sound: '/order-in-transit.mp3',
          vibrate: [300, 100, 300],
        };
        apiNamespace.to('admin').emit('orderInTransit', transitEventData);
        apiNamespace.to('production').emit('orderInTransit', transitEventData);
        if (order.branch) {
          apiNamespace.to(`branch-${order.branch._id}`).emit('orderInTransit', transitEventData);
        }
        await createNotification({
          title: `الطلب في الطريق`,
          message: `الطلب ${order.orderNumber} في حالة الشحن إلى فرع ${order.branch.name || 'غير معروف'}`,
          userId: socket.user.id,
          role: ['admin', 'production'],
          branchId: order.branch._id,
        });
      }
      if (status === 'delivered') {
        const deliveredEventData = {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch._id,
          branchName: order.branch.name || 'Unknown',
          deliveredAt: new Date().toISOString(),
          sound: '/order-delivered.mp3',
          vibrate: [300, 100, 300],
        };
        apiNamespace.to('admin').emit('orderDelivered', deliveredEventData);
        apiNamespace.to('production').emit('orderDelivered', deliveredEventData);
        if (order.branch) {
          apiNamespace.to(`branch-${order.branch._id}`).emit('orderDelivered', deliveredEventData);
        }
        await createNotification({
          title: `تم تسليم الطلب`,
          message: `تم تسليم الطلب ${order.orderNumber} إلى فرع ${order.branch.name || 'غير معروف'}`,
          userId: socket.user.id,
          role: ['admin', 'production'],
          branchId: order.branch._id,
        });
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting orderStatusUpdated: ${err.message}`);
    }
  });

  socket.on('returnStatusUpdated', async ({ returnId, status, returnNote }) => {
    try {
      const eventData = {
        returnId,
        status,
        returnNote,
        sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
        vibrate: [200, 100, 200],
      };
      apiNamespace.to('admin').emit('returnStatusUpdated', eventData);
      apiNamespace.to('production').emit('returnStatusUpdated', eventData);
      const returnRequest = await require('./models/Return').findById(returnId).populate('order', 'branch').lean();
      if (returnRequest?.order?.branch) {
        apiNamespace.to(`branch-${returnRequest.order.branch}`).emit('returnStatusUpdated', eventData);
      }
      await createNotification({
        title: `تحديث حالة الإرجاع`,
        message: `تم تحديث حالة الإرجاع ${returnId} إلى ${status}`,
        userId: socket.user.id,
        role: ['admin', 'production'],
        branchId: returnRequest?.order?.branch,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting returnStatusUpdated: ${err.message}`);
    }
  });

  socket.on('missingAssignments', async (data) => {
    try {
      const eventData = { ...data, sound: '/notification.mp3', vibrate: [400, 100, 400] };
      apiNamespace.to('admin').emit('missingAssignments', eventData);
      apiNamespace.to('production').emit('missingAssignments', eventData);
      const order = await require('./models/Order').findById(data.orderId).lean();
      if (order?.branch) {
        apiNamespace.to(`branch-${order.branch}`).emit('missingAssignments', eventData);
      }
      await createNotification({
        title: `عناصر غير مخصصة`,
        message: `هناك عناصر غير مخصصة في الطلب ${data.orderId}`,
        userId: socket.user.id,
        role: ['admin', 'production'],
        branchId: order?.branch,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error emitting missingAssignments: ${err.message}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${new Date().toISOString()}] User disconnected from /api namespace: ${socket.id}, Reason: ${reason}`);
  });

  socket.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Socket error: ${err.message}`);
  });

  socket.on('connect_error', (err) => {
    console.error(`[${new Date().toISOString()}] Socket connect_error: ${err.message}`);
  });
});

// الاتصال بقاعدة البيانات
connectDB().catch((err) => {
  console.error(`[${new Date().toISOString()}] Failed to connect to MongoDB: ${err.message}`);
  process.exit(1);
});

// تجاهل طلبات socket.io في Express
app.use('/socket.io', (req, res, next) => next());

// إعداد Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 500, // الحد الأقصى للطلبات
  message: 'عدد الطلبات تجاوز الحد المسموح، يرجى المحاولة مرة أخرى بعد 15 دقيقة',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// إعدادات الـ Middleware
if (compression) app.use(compression());
app.use(morgan('combined', {
  stream: {
    write: (message) => console.log(`[${new Date().toISOString()}] ${message.trim()}`),
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// تمرير io إلى التطبيق
app.set('io', io);

// المسارات
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

// نقطة نهاية لفحص الحالة
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'production',
    time: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// معالجة الأخطاء العامة
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error: ${err.message}, Stack: ${err.stack}`);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? 'خطأ في السيرفر' : err.message,
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
});

// التعامل مع إغلاق الخادم
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM. Closing server gracefully.`);
  server.close(() => {
    console.log(`[${new Date().toISOString()}] HTTP server closed.`);
    require('mongoose').connection.close(false, () => {
      console.log(`[${new Date().toISOString()}] MongoDB connection closed.`);
      if (process.env.REDIS_URL) {
        Promise.all([pubClient?.quit(), subClient?.quit()])
          .then(() => console.log(`[${new Date().toISOString()}] Redis connections closed.`))
          .catch((err) => console.error(`[${new Date().toISOString()}] Error closing Redis connections: ${err.message}`))
          .finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});