// index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://your-client-domain.vercel.app',
  'https://eljoodia-server-production.up.railway.app',
];

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('غير مسموح بالوصول عبر CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        'wss://eljoodia-server-production.up.railway.app',
        'https://eljoodia-server-production.up.railway.app',
        'http://localhost:3000',
        'ws://localhost:3000',
        'http://localhost:3001',
        'ws://localhost:3001',
      ],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
    },
  })
);
app.use(morgan('combined'));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 100,
  message: 'عدد الطلبات كبير جدًا، حاول مرة أخرى لاحقًا.',
});
const refreshTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'طلبات تجديد التوكن كثيرة جدًا، حاول مرة أخرى لاحقًا.',
});
app.use(limiter);

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('MongoDB متصل'))
  .catch((err) => console.error('خطأ في الاتصال بـ MongoDB:', err));

// Models
const OrderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
  items: [
    {
      product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
      quantity: { type: Number, required: true },
      price: { type: Number, required: true },
      department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
      assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      status: {
        type: String,
        enum: ['pending', 'assigned', 'in_progress', 'completed'],
        default: 'pending',
      },
      returnedQuantity: { type: Number, default: 0 },
      returnReason: { type: String },
    },
  ],
  returns: [
    {
      status: {
        type: String,
        enum: ['pending_approval', 'approved', 'rejected', 'processed'],
        default: 'pending_approval',
      },
      items: [
        {
          product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
          quantity: { type: Number, required: true },
          reason: { type: String, required: true },
        },
      ],
      reviewNotes: { type: String },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  status: {
    type: String,
    enum: ['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'],
    default: 'pending',
  },
  totalAmount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  notes: { type: String },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});
const Order = mongoose.model('Order', OrderSchema);

const NotificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: Object },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const Notification = mongoose.model('Notification', NotificationSchema);

const ChefSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
});
const Chef = mongoose.model('Chef', ChefSchema);

// Routes
app.use('/api/auth', require('./routes/auth')); // استخدام ملف auth.js اللي قدمته

const ordersRouter = express.Router();
const { auth, authorize } = require('../middleware/auth');

ordersRouter.get('/', auth, async (req, res) => {
  try {
    const { status, department } = req.query;
    const query = {};
    if (status) query.status = status;
    if (req.user.role === 'production' && req.user.department) {
      query['items.department'] = req.user.department;
    } else if (department) {
      query['items.department'] = department;
    }
    const orders = await Order.find(query).populate('branch createdBy items.product items.assignedTo items.department returns.items.product');
    res.json(orders);
  } catch (err) {
    console.error(`خطأ في جلب الطلبات في ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

ordersRouter.patch('/:id/status', auth, authorize('admin', 'production'), async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    order.status = status;
    await order.save();
    io.of('/orders').emit('orderStatusUpdated', { orderId: order._id, status });
    await Notification.create({
      user: req.user.id,
      type: 'order_status_updated',
      message: `تم تحديث حالة الطلب #${order.orderNumber} إلى ${status}`,
      data: { orderId: order._id },
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error(`خطأ في تحديث حالة الطلب في ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

ordersRouter.patch('/:id/assign', auth, authorize('admin', 'production'), async (req, res) => {
  try {
    const { items } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    order.items = order.items.map((item) => {
      const assignment = items.find((i) => i.itemId === item._id.toString());
      if (assignment) {
        return { ...item, assignedTo: assignment.assignedTo, status: 'assigned' };
      }
      return item;
    });
    order.status = 'in_production';
    await order.save();
    io.of('/orders').emit('taskAssigned', { orderId: order._id, items });
    await Notification.create({
      user: req.user.id,
      type: 'task_assigned',
      message: `تم تعيين مهام للطلب #${order.orderNumber}`,
      data: { orderId: order._id },
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error(`خطأ في تعيين الشيف في ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

const notificationsRouter = express.Router();
notificationsRouter.get('/', auth, async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50);
    res.status(200).json(notifications);
  } catch (err) {
    console.error(`خطأ في جلب الإشعارات في ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

notificationsRouter.patch('/:id/read', auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }
    res.status(200).json(notification);
  } catch (err) {
    console.error(`خطأ في تحديث الإشعار في ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

const chefsRouter = express.Router();
chefsRouter.get('/', auth, async (req, res) => {
  try {
    const chefs = await Chef.find().populate('user department');
    res.json(chefs);
  } catch (err) {
    console.error(`خطأ في جلب الشيفات في ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

app.use('/api/orders', ordersRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/chefs', chefsRouter);

// Socket.IO Configuration
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 20,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
});

const ordersNamespace = io.of('/orders');
ordersNamespace.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  console.log(`محاولة توثيق Socket في ${new Date().toISOString()}:`, { token: token ? token.substring(0, 10) + '...' : 'لا يوجد توكن' });
  if (!token) {
    return next(new Error('خطأ في التوثيق: التوكن مطلوب'));
  }
  try {
    const cleanedToken = token.startsWith('Bearer ') ? token.replace('Bearer ', '') : token;
    const decoded = jwt.verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
    const user = await require('../models/User').findById(decoded.id).lean();
    if (!user) {
      return next(new Error('خطأ في التوثيق: المستخدم غير موجود'));
    }
    socket.user = { id: decoded.id, username: decoded.username, role: decoded.role, branchId: decoded.branchId, departmentId: decoded.departmentId };
    next();
  } catch (err) {
    console.error(`خطأ في توثيق Socket في ${new Date().toISOString()}:`, err);
    return next(new Error(`خطأ في التوثيق: ${err.message}`));
  }
});

ordersNamespace.on('connection', (socket) => {
  console.log(`مستخدم متصل بنطاق /orders: ${socket.id}, المستخدم: ${socket.user.username}`);
  socket.on('joinRoom', ({ role, branchId, chefId, departmentId }) => {
    if (role === 'admin') socket.join('admin');
    if (branchId) socket.join(`branch:${branchId}`);
    if (chefId) socket.join(`chef:${chefId}`);
    if (departmentId) socket.join(`department:${departmentId}`);
    console.log(`المستخدم ${socket.user.username} انضم للغرف:`, { role, branchId, chefId, departmentId });
  });

  socket.on('disconnect', () => {
    console.log(`مستخدم انفصل: ${socket.id}`);
  });
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(`خطأ في ${new Date().toISOString()}:`, err.stack);
  res.status(500).json({ success: false, message: 'حدث خطأ في الخادم!' });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`الخادم يعمل على المنفذ ${PORT}`);
});