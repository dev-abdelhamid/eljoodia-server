// index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
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
        callback(new Error('Not allowed by CORS'));
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
});
const refreshTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many refresh token requests, please try again later.',
});
app.use(limiter);

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Models
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['admin', 'production', 'chef'], required: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  lastLogin: { type: Date },
  comparePassword: async function (password) {
    return password === this.password; // Replace with bcrypt in production
  },
});
const User = mongoose.model('User', UserSchema);

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

// Middleware for Authentication
const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    req.user = { id: decoded.id, username: decoded.username, role: decoded.role, branch: decoded.branchId, department: decoded.departmentId };
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Routes
const authRouter = express.Router();
const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role, branchId: user.branch, departmentId: user.department },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m' }
  );
};
const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
};

authRouter.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    user.lastLogin = new Date();
    await user.save();
    res.json({
      success: true,
      token: accessToken,
      refreshToken,
      user: {
        id: user._id.toString(),
        username: user.username,
        role: user.role,
        branchId: user.branch?.toString(),
        departmentId: user.department?.toString(),
      },
    });
  } catch (error) {
    console.error(`Login error at ${new Date().toISOString()}:`, error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

authRouter.post('/refresh-token', refreshTokenLimiter, async (req, res) => {
  const refreshToken = req.body.refreshToken || req.header('Authorization')?.replace('Bearer ', '');
  if (!refreshToken) {
    return res.status(401).json({ success: false, message: 'Refresh token required' });
  }
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);
    res.status(200).json({ success: true, token: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error(`Refresh token error at ${new Date().toISOString()}:`, err);
    res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
});

authRouter.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    res.json({ success: true, user: { id: user._id, username: user.username, role: user.role, branchId: user.branch, departmentId: user.department } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const ordersRouter = express.Router();
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
    console.error(`Fetch orders error at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

ordersRouter.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (!['admin', 'production'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    order.status = status;
    await order.save();
    io.of('/orders').emit('orderStatusUpdated', { orderId: order._id, status });
    await Notification.create({
      user: req.user.id,
      type: 'order_status_updated',
      message: `Order #${order.orderNumber} status updated to ${status}`,
      data: { orderId: order._id },
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error(`Update order status error at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

ordersRouter.patch('/:id/assign', auth, async (req, res) => {
  try {
    const { items } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (!['admin', 'production'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
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
      message: `Tasks assigned for order #${order.orderNumber}`,
      data: { orderId: order._id },
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error(`Assign chef error at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error' });
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
    console.error(`Fetch notifications error at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error' });
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
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    res.status(200).json(notification);
  } catch (err) {
    console.error(`Update notification error at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const chefsRouter = express.Router();
chefsRouter.get('/', auth, async (req, res) => {
  try {
    const chefs = await Chef.find().populate('user department');
    res.json(chefs);
  } catch (err) {
    console.error(`Fetch chefs error at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.use('/api/auth', authRouter);
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
  console.log(`Socket auth attempt at ${new Date().toISOString()}:`, { token: token ? token.substring(0, 10) + '...' : 'No token' });
  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const cleanedToken = token.startsWith('Bearer ') ? token.replace('Bearer ', '') : token;
    const decoded = jwt.verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      return next(new Error('Authentication error: User not found'));
    }
    socket.user = { id: decoded.id, username: decoded.username, role: decoded.role, branchId: decoded.branchId, departmentId: decoded.departmentId };
    next();
  } catch (err) {
    console.error(`Socket auth error at ${new Date().toISOString()}:`, err);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

ordersNamespace.on('connection', (socket) => {
  console.log(`User connected to /orders namespace: ${socket.id}, User: ${socket.user.username}`);
  socket.on('joinRoom', ({ role, branchId, chefId, departmentId }) => {
    if (role === 'admin') {
      socket.join('admin');
    }
    if (branchId) {
      socket.join(`branch:${branchId}`);
    }
    if (chefId) {
      socket.join(`chef:${chefId}`);
    }
    if (departmentId) {
      socket.join(`department:${departmentId}`);
    }
    console.log(`User ${socket.user.username} joined rooms`, { role, branchId, chefId, departmentId });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(`Error at ${new Date().toISOString()}:`, err.stack);
  res.status(500).json({ success: false, message: 'Something went wrong!' });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});