const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = false) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data, saveToDb });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'orderCreated',
      'orderCompleted',
      'taskAssigned',
      'orderApproved',
      'orderInTransit',
      'orderDelivered',
      'branchConfirmedReceipt',
      'taskStarted',
      'taskCompleted'
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = data.eventId || `${data.orderId || data.taskId || 'generic'}-${type}-${userId}`;
    if (saveToDb) {
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
      if (existingNotification) {
        console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
        return existingNotification;
      }
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name nameEn')
      .lean();

    if (!targetUser) {
      throw new Error('المستخدم غير موجود');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    let notification;
    if (saveToDb) {
      notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: message.trim(),
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id).populate('user', 'username role branch').lean()
      : { _id: uuidv4(), user: targetUser, type, message, data: { ...data, eventId }, read: false, createdAt: new Date() };

    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      message: populatedNotification.message,
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        orderId: data.orderId,
        taskId: data.taskId,
        chefId: data.chefId,
      },
      read: populatedNotification.read,
      user: {
        _id: targetUser._id,
        username: targetUser.username,
        role: targetUser.role,
        branch: targetUser.branch || null,
      },
      createdAt: populatedNotification.createdAt,
      sound: `${baseUrl}/sounds/notification.mp3`,
      soundType: 'notification',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
      taskAssigned: ['admin', 'production', 'chef'],
      orderApproved: ['admin', 'production', 'branch'],
      orderInTransit: ['admin', 'production', 'branch'],
      orderDelivered: ['admin', 'production', 'branch'],
      branchConfirmedReceipt: ['admin', 'production', 'branch'],
      taskStarted: ['admin', 'production', 'chef'],
      taskCompleted: ['admin', 'production', 'chef'],
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && (data.branchId || targetUser.branch?._id)) rooms.add(`branch-${data.branchId || targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, { eventData });
    });

    return notification || populatedNotification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, {
      message: err.message,
      stack: err.stack,
      userId,
      type,
      data,
    });
    throw err;
  }
};

const setupNotifications = (io, socket) => {
  // دالة مساعدة لإرسال الإشعارات إلى غرف معينة
  const emitToRooms = (rooms, eventName, eventData) => {
    const uniqueRooms = [...new Set(rooms)];
    uniqueRooms.forEach(room => {
      io.to(room).emit(eventName, eventData);
      console.log(`[${new Date().toISOString()}] Emitted ${eventName} to room ${room}:`, { eventData });
    });
  };

  socket.on('joinRoom', (rooms) => {
    if (Array.isArray(rooms)) {
      rooms.forEach(room => {
        socket.join(room);
        console.log(`[${new Date().toISOString()}] Socket ${socket.id} joined room: ${room}`);
      });
    } else {
      socket.join(rooms);
      console.log(`[${new Date().toISOString()}] Socket ${socket.id} joined room: ${rooms}`);
    }
  });

  socket.on('orderCreated', async (data) => {
    const { orderId, orderNumber, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name nameEn')
        .session(session)
        .lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `طلب جديد ${orderNumber} من ${order.branch?.name || 'غير معروف'}`
        : `New order ${orderNumber} from ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'orderCreated',
        message,
        data: { orderId, orderNumber, branchId, eventId: `${orderId}-orderCreated` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean().session(session);

      await Promise.all([
        ...adminUsers.map(user => createNotification(
          user._id,
          'orderCreated',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...productionUsers.map(user => createNotification(
          user._id,
          'orderCreated',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...branchUsers.map(user => createNotification(
          user._id,
          'orderCreated',
          isRtl ? `تم إنشاء طلبك رقم ${orderNumber} بنجاح` : `Order ${orderNumber} created successfully`,
          { ...eventData.data, isRtl, type: 'toast' },
          io,
          false
        )),
      ]);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });

  socket.on('taskAssigned', async (data) => {
    const { orderId, taskId, chefId, productId, productName, quantity, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `تم تعيينك لإنتاج ${productName || 'غير معروف'} في الطلب ${order.orderNumber || 'غير معروف'}`
        : `Assigned to produce ${productName || 'Unknown'} in order ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskAssigned-${Date.now()}`,
        type: 'taskAssigned',
        message,
        data: { orderId, taskId, branchId, chefId, productId, productName, quantity, eventId: `${taskId}-taskAssigned` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `chef-${chefId}`, `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      await createNotification(
        chefId,
        'taskAssigned',
        message,
        { ...eventData.data, isRtl, type: 'persistent' },
        io,
        true
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });

  socket.on('orderApproved', async (data) => {
    const { orderId, orderNumber, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `تم اعتماد الطلب ${orderNumber} من ${order.branch?.name || 'غير معروف'}`
        : `Order ${orderNumber} approved from ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderApproved-${Date.now()}`,
        type: 'orderApproved',
        message,
        data: { orderId, orderNumber, branchId, eventId: `${orderId}-orderApproved` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean().session(session);

      await Promise.all([
        ...adminUsers.map(user => createNotification(
          user._id,
          'orderApproved',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...productionUsers.map(user => createNotification(
          user._id,
          'orderApproved',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...branchUsers.map(user => createNotification(
          user._id,
          'orderApproved',
          isRtl ? `تم اعتماد طلبك رقم ${orderNumber} بنجاح` : `Order ${orderNumber} approved successfully`,
          { ...eventData.data, isRtl, type: 'toast' },
          io,
          false
        )),
      ]);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });

  socket.on('orderInTransit', async (data) => {
    const { orderId, orderNumber, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'غير معروف'}`
        : `Order ${orderNumber} is in transit to ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderInTransit-${Date.now()}`,
        type: 'orderInTransit',
        message,
        data: { orderId, orderNumber, branchId, eventId: `${orderId}-orderInTransit` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean().session(session);

      await Promise.all([
        ...adminUsers.map(user => createNotification(
          user._id,
          'orderInTransit',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...productionUsers.map(user => createNotification(
          user._id,
          'orderInTransit',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...branchUsers.map(user => createNotification(
          user._id,
          'orderInTransit',
          isRtl ? `طلبك رقم ${orderNumber} في طريقه إليك` : `Order ${orderNumber} is in transit to you`,
          { ...eventData.data, isRtl, type: 'toast' },
          io,
          false
        )),
      ]);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });

  socket.on('orderDelivered', async (data) => {
    const { orderId, orderNumber, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `تم توصيل الطلب ${orderNumber} إلى ${order.branch?.name || 'غير معروف'}`
        : `Order ${orderNumber} delivered to ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderDelivered-${Date.now()}`,
        type: 'orderDelivered',
        message,
        data: { orderId, orderNumber, branchId, eventId: `${orderId}-orderDelivered` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean().session(session);

      await Promise.all([
        ...adminUsers.map(user => createNotification(
          user._id,
          'orderDelivered',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...productionUsers.map(user => createNotification(
          user._id,
          'orderDelivered',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...branchUsers.map(user => createNotification(
          user._id,
          'orderDelivered',
          isRtl ? `تم توصيل طلبك رقم ${orderNumber} بنجاح` : `Order ${orderNumber} delivered successfully`,
          { ...eventData.data, isRtl, type: 'toast' },
          io,
          false
        )),
      ]);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order delivered:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });

  socket.on('branchConfirmedReceipt', async (data) => {
    const { orderId, orderNumber, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'غير معروف'}`
        : `Order ${orderNumber} receipt confirmed by ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-branchConfirmedReceipt-${Date.now()}`,
        type: 'branchConfirmedReceipt',
        message,
        data: { orderId, orderNumber, branchId, eventId: `${orderId}-branchConfirmedReceipt` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean().session(session);

      await Promise.all([
        ...adminUsers.map(user => createNotification(
          user._id,
          'branchConfirmedReceipt',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...productionUsers.map(user => createNotification(
          user._id,
          'branchConfirmedReceipt',
          message,
          { ...eventData.data, isRtl, type: 'persistent' },
          io,
          true
        )),
        ...branchUsers.map(user => createNotification(
          user._id,
          'branchConfirmedReceipt',
          isRtl ? `تم تأكيد استلام طلبك رقم ${orderNumber} بنجاح` : `Order ${orderNumber} receipt confirmed successfully`,
          { ...eventData.data, isRtl, type: 'toast' },
          io,
          false
        )),
      ]);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling branch confirmed receipt:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });

  socket.on('taskStarted', async (data) => {
    const { orderId, taskId, chefId, productName, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `بدأ الشيف العمل على (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`
        : `Chef started working on (${productName || 'Unknown'}) in order ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskStarted-${Date.now()}`,
        type: 'taskStarted',
        message,
        data: { orderId, taskId, branchId, chefId, productName, eventId: `${taskId}-taskStarted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `chef-${chefId}`, `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      await createNotification(
        chefId,
        'taskStarted',
        message,
        { ...eventData.data, isRtl, type: 'persistent' },
        io,
        true
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task started:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });

  socket.on('taskCompleted', async (data) => {
    const { orderId, taskId, chefId, productName, branchId, isRtl } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session);
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = isRtl
        ? `تم إكمال مهمة (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}`
        : `Task (${productName || 'Unknown'}) completed in order ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskCompleted-${Date.now()}`,
        type: 'taskCompleted',
        message,
        data: { orderId, taskId, branchId, chefId, productName, eventId: `${taskId}-taskCompleted` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = ['admin', 'production', `chef-${chefId}`, `branch-${branchId}`];
      emitToRooms(rooms, 'newNotification', eventData);

      await createNotification(
        chefId,
        'taskCompleted',
        message,
        { ...eventData.data, isRtl, type: 'persistent' },
        io,
        true
      );

      const allTasksCompleted = order.items.every(item => item.status === 'completed');
      if (allTasksCompleted) {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
          notes: isRtl ? 'تم إكمال جميع المهام' : 'All tasks completed',
        });
        await order.save({ session });

        const completionMessage = isRtl
          ? `تم اكتمال الطلب ${order.orderNumber} بالكامل`
          : `Order ${order.orderNumber} completed fully`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: completionMessage,
          data: { orderId, orderNumber, branchId, eventId: `${orderId}-orderCompleted` },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const completionRooms = ['admin', 'production', `branch-${branchId}`, `chef-${chefId}`];
        emitToRooms(completionRooms, 'newNotification', completionEventData);

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
        const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean().session(session);
        const chefUsers = await User.find({ _id: chefId }).select('_id').lean().session(session);

        await Promise.all([
          ...adminUsers.map(user => createNotification(
            user._id,
            'orderCompleted',
            completionMessage,
            { ...completionEventData.data, isRtl, type: 'persistent' },
            io,
            true
          )),
          ...productionUsers.map(user => createNotification(
            user._id,
            'orderCompleted',
            completionMessage,
            { ...completionEventData.data, isRtl, type: 'persistent' },
            io,
            true
          )),
          ...branchUsers.map(user => createNotification(
            user._id,
            'orderCompleted',
            isRtl ? `تم اكتمال طلبك رقم ${orderNumber} بنجاح` : `Order ${orderNumber} completed successfully`,
            { ...completionEventData.data, isRtl, type: 'toast' },
            io,
            false
          )),
          ...chefUsers.map(user => createNotification(
            user._id,
            'orderCompleted',
            completionMessage,
            { ...completionEventData.data, isRtl, type: 'persistent' },
            io,
            true
          )),
        ]);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      session.endSession();
    }
  });
};

module.exports = { createNotification, setupNotifications };