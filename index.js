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
const inventoryRoutes = require('./routes/Inventory');
const salesRoutes = require('./routes/sales');

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

// Socket.IO Authentication Middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const decoded = await jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id, 'Namespace:', socket.nsp.name);

  socket.on('error', (err) => {
    console.error('Socket error:', err, 'Token:', socket.handshake.auth.token);
  });

  socket.on('joinRoom', ({ role, branchId, chefId, departmentId }) => {
    if (role === 'admin') socket.join('admin');
    if (role === 'branch' && branchId) socket.join(`branch-${branchId}`);
    if (role === 'production') socket.join('production');
    if (role === 'chef' && chefId) socket.join(`chef-${chefId}`);
    if (role === 'production' && departmentId) socket.join(`department-${departmentId}`);
    console.log(`User joined rooms: role=${role}, branchId=${branchId}, chefId=${chefId}, departmentId=${departmentId}`);
  });

  socket.on('disconnect', (reason) => {
    console.log('User disconnected:', socket.id, 'Reason:', reason);
  });
});

connectDB().catch((err) => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_URL || 'https://eljoodia.vercel.app',
    credentials: true,
  })
);
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);
if (compression) {
  app.use(compression());
} else {
  console.log('Running without compression middleware');
}
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

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'development' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
