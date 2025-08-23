});
    if (order?.branch?._id) {
      apiNamespace.to(`branch-${order.branch._id}`).emit('orderStatusUpdated', eventData);
    }
  });

  socket.on('orderCompleted', async (data) => {
    const eventData = { ...data, sound: '/order-completed.mp3', vibrate: [300, 100, 300] };
    apiNamespace.to('admin').emit('orderCompleted', eventData);
    apiNamespace.to('production').emit('orderCompleted', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('orderCompleted', eventData);
      console.log(`[${new Date().toISOString()}] Emitted orderCompleted to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('orderInTransit', async (data) => {
    const eventData = { ...data, sound: '/order-in-transit.mp3', vibrate: [300, 100, 300] };
    apiNamespace.to('admin').emit('orderInTransit', eventData);
    apiNamespace.to('production').emit('orderInTransit', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('orderInTransit', eventData);
      console.log(`[${new Date().toISOString()}] Emitted orderInTransit to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('orderDelivered', async (data) => {
    const eventData = { ...data, sound: '/order-delivered.mp3', vibrate: [300, 100, 300] };
    apiNamespace.to('admin').emit('orderDelivered', eventData);
    apiNamespace.to('production').emit('orderDelivered', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('orderDelivered', eventData);
      console.log(`[${new Date().toISOString()}] Emitted orderDelivered to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('returnStatusUpdated', async (data) => {
    const eventData = { ...data, sound: data.status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3', vibrate: [200, 100, 200] };
    apiNamespace.to('admin').emit('returnStatusUpdated', eventData);
    apiNamespace.to('production').emit('returnStatusUpdated', eventData);
    if (data.branchId) {
      apiNamespace.to(`branch-${data.branchId}`).emit('returnStatusUpdated', eventData);
      console.log(`[${new Date().toISOString()}] Emitted returnStatusUpdated to branch-${data.branchId}:`, eventData);
    }
  });

  socket.on('newNotification', async (data) => {
    const eventData = { ...data, sound: data.sound || '/notification.mp3', vibrate: data.vibrate || [200, 100, 200] };
    apiNamespace.to(`user-${data.user._id}`).emit('newNotification', eventData);
    if (data.user.role === 'admin') apiNamespace.to('admin').emit('newNotification', eventData);
    if (data.user.role === 'production') apiNamespace.to('production').emit('newNotification', eventData);
    if (data.user.role === 'branch' && data.branch?._id) {
      apiNamespace.to(`branch-${data.branch._id}`).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Emitted newNotification to branch-${data.branch._id}:`, eventData);
    }
    if (data.user.role === 'chef' && data.user.department?._id) {
      apiNamespace.to(`department-${data.user.department._id}`).emit('newNotification', eventData);
    }
  });

  socket.on('notificationUpdated', (data) => {
    apiNamespace.to(`user-${data.id}`).emit('notificationUpdated', data);
    console.log(`[${new Date().toISOString()}] Emitted notificationUpdated to user-${data.id}:`, data);
  });

  socket.on('notificationDeleted', (data) => {
    apiNamespace.to(`user-${data.id}`).emit('notificationDeleted', data);
    console.log(`[${new Date().toISOString()}] Emitted notificationDeleted to user-${data.id}:`, data);
  });

  socket.on('allNotificationsRead', (data) => {
    apiNamespace.to(`user-${data.user}`).emit('allNotificationsRead', data);
    console.log(`[${new Date().toISOString()}] Emitted allNotificationsRead to user-${data.user}:`, data);
  });

  socket.on('disconnect', () => {
    console.log(`[${new Date().toISOString()}] Disconnected from /api namespace: ${socket.id}, User: ${socket.user.username}`);
  });

  socket.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Socket error: ${err.message}`);
  });
});

app.set('io', apiNamespace);

app.use(morgan('combined'));
if (compression) app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.',
});
app.use(limiter);

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

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Eljoodia Server' });
});

app.use((req, res) => {
  console.error(`[${new Date().toISOString()}] 404 Not Found: ${req.method} ${req.url}`);
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Server error:`, {
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
    user: req.user ? req.user.id : 'unauthenticated',
  });
  res.status(500).json({ success: false, message: 'Internal Server Error', error: err.message });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
  });
}).catch((err) => {
  console.error(`[${new Date().toISOString()}] Database connection error:`, err);
  process.exit(1);
});

module.exports = { app, server, io: apiNamespace };
