const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = true) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data, saveToDb });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'orderCreated',
      'orderCompleted',
      'taskAssigned',
      'taskStarted',
      'taskCompleted',
      'orderApproved',
      'orderInTransit',
      'orderDelivered',
      'branchConfirmedReceipt',
    ];
    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    const eventId = data.eventId || `${data.orderId || data.taskId || 'generic'}-${type}-${Date.now()}`;
    if (saveToDb) {
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
      if (existingNotification) {
        console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
        return existingNotification;
      }
    }

    const targetUser = await User.findById(userId)
      .select('username name role branch department')
      .populate('branch', 'name')
      .populate('department', 'name code')
      .lean();

    if (!targetUser) {
      throw new Error('المستخدم غير موجود');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    let notification;
    const notificationData = {
      ...data,
      eventId,
      branchId: data.branchId || targetUser.branch?._id?.toString(),
      branchName: data.branchName || targetUser.branch?.name || 'غير معروف',
      orderNumber: data.orderNumber,
      productName: data.productName,
      quantity: data.quantity,
    };

    if (saveToDb) {
      notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: message.trim(),
        data: notificationData,
        read: false,
        createdAt: new Date(),
        timestamp: new Date().toISOString(),
        sound: data.sound || `${baseUrl}/sounds/notification.mp3`,
        vibrate: data.vibrate || [200, 100, 200],
      });
      await notification.save();
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id)
          .populate('user', 'username name role branch department')
          .populate('branch', 'name')
          .populate('department', 'name code')
          .lean()
      : {
          _id: uuidv4(),
          user: targetUser,
          type,
          message: message.trim(),
          data: notificationData,
          read: false,
          createdAt: new Date(),
          timestamp: new Date().toISOString(),
          sound: data.sound || `${baseUrl}/sounds/notification.mp3`,
          vibrate: data.vibrate || [200, 100, 200],
        };

    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      message: populatedNotification.message,
      data: {
        ...populatedNotification.data,
        branchId: notificationData.branchId,
        branchName: notificationData.branchName,
        orderId: data.orderId,
        orderNumber: data.orderNumber,
        taskId: data.taskId,
        chefId: data.chefId,
        productName: data.productName,
        quantity: data.quantity,
        items: data.items?.map(item => ({
          _id: item._id,
          product: item.product
            ? { _id: item.product._id, name: item.product.name || 'غير معروف', unit: item.product.unit || 'unit' }
            : undefined,
          assignedTo: item.assignedTo
            ? {
                _id: item.assignedTo._id,
                name: item.assignedTo.name || item.assignedTo.username || 'غير معروف',
                username: item.assignedTo.username || 'غير معروف',
                department: item.assignedTo.department || { _id: 'unknown', name: 'غير معروف' },
              }
            : undefined,
          status: item.status || 'assigned',
        })),
      },
      read: populatedNotification.read,
      user: {
        _id: targetUser._id,
        username: targetUser.username || 'غير معروف',
        name: targetUser.name || 'غير معروف',
        role: targetUser.role,
        branch: targetUser.branch || null,
        department: targetUser.department || null,
      },
      createdAt: populatedNotification.createdAt,
      sound: populatedNotification.sound,
      soundType: 'notification',
      vibrate: populatedNotification.vibrate,
      timestamp: populatedNotification.timestamp,
    };

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
      taskAssigned: ['admin', 'production', 'chef'],
      taskStarted: ['admin', 'production', 'chef'],
      taskCompleted: ['admin', 'production', 'chef'],
      orderApproved: ['admin', 'production', 'branch'],
      orderInTransit: ['admin', 'production', 'branch'],
      orderDelivered: ['admin', 'production', 'branch'],
      branchConfirmedReceipt: ['admin', 'production', 'branch'],
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && notificationData.branchId) rooms.add(`branch-${notificationData.branchId}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
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
  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .populate({ path: 'items.product', select: 'name unit department', populate: { path: 'department', select: 'name code' } })
        .session(session)
        .lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `طلب جديد ${orderNumber} من ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'orderCreated',
        message,
        data: {
          orderId,
          orderNumber,
          branchId: order.branch?._id || branchId,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${orderId}-orderCreated`,
          items: order.items.map(item => ({
            _id: item._id,
            product: {
              _id: item.product._id,
              name: item.product.name || 'غير معروف',
              unit: item.product.unit || 'unit',
              department: item.product.department || { _id: 'unknown', name: 'غير معروف' },
            },
            quantity: item.quantity,
            status: item.status,
          })),
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderCreated', message, eventData.data, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskAssigned = async (data) => {
    const { orderId, taskId, chefId, productId, productName, quantity, branchId, itemId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .populate({ path: 'items.product', select: 'name unit department', populate: { path: 'department', select: 'name code' } })
        .session(session)
        .lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }
      if (order.status !== 'approved') {
        console.error(`[${new Date().toISOString()}] Order not approved: ${orderId}`);
        return;
      }

      const product = await Product.findById(productId)
        .populate('department', 'name code')
        .session(session)
        .lean();
      if (!product) {
        console.error(`[${new Date().toISOString()}] Product not found: ${productId}`);
        return;
      }

      const chef = await User.findById(chefId)
        .select('username name department')
        .populate('department', 'name code')
        .session(session)
        .lean();
      if (!chef || chef.role !== 'chef') {
        console.error(`[${new Date().toISOString()}] Invalid chef: ${chefId}`);
        return;
      }

      const orderItem = order.items.find(item => item._id.toString() === itemId);
      if (!orderItem) {
        console.error(`[${new Date().toISOString()}] Order item not found: ${itemId}`);
        return;
      }

      const message = `تم تعيينك لإنتاج ${productName || product.name || 'غير معروف'} في الطلب ${order.orderNumber || 'غير معروف'} (الفرع: ${order.branch?.name || 'غير معروف'})`;
      const eventData = {
        _id: `${taskId}-taskAssigned-${Date.now()}`,
        type: 'taskAssigned',
        message,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          taskId,
          branchId: order.branch?._id || branchId,
          branchName: order.branch?.name || 'غير معروف',
          chefId,
          productId,
          productName: productName || product.name || 'غير معروف',
          quantity,
          itemId,
          eventId: `${taskId}-taskAssigned`,
          items: [{
            _id: itemId,
            product: {
              _id: product._id,
              name: product.name || 'غير معروف',
              unit: product.unit || 'unit',
              department: product.department || { _id: 'unknown', name: 'غير معروف' },
            },
            assignedTo: {
              _id: chef._id,
              name: chef.name || chef.username || 'غير معروف',
              username: chef.username || 'غير معروف',
              department: chef.department || { _id: 'unknown', name: 'غير معروف' },
            },
            status: 'assigned',
            quantity,
          }],
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id || branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskAssigned', message, eventData.data, io, true);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskStarted = async (data) => {
    const { orderId, taskId, chefId, productName, productId, itemId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .populate({ path: 'items.product', select: 'name unit department', populate: { path: 'department', select: 'name code' } })
        .session(session)
        .lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const product = await Product.findById(productId)
        .populate('department', 'name code')
        .session(session)
        .lean();
      if (!product) {
        console.error(`[${new Date().toISOString()}] Product not found: ${productId}`);
        return;
      }

      const chef = await User.findById(chefId)
        .select('username name department')
        .populate('department', 'name code')
        .session(session)
        .lean();
      if (!chef || chef.role !== 'chef') {
        console.error(`[${new Date().toISOString()}] Invalid chef: ${chefId}`);
        return;
      }

      const orderItem = order.items.find(item => item._id.toString() === itemId);
      if (!orderItem) {
        console.error(`[${new Date().toISOString()}] Order item not found: ${itemId}`);
        return;
      }

      const message = `بدأ الشيف العمل على (${productName || product.name || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'} (الفرع: ${order.branch?.name || 'غير معروف'})`;
      const eventData = {
        _id: `${taskId}-taskStarted-${Date.now()}`,
        type: 'taskStarted',
        message,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          taskId,
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'غير معروف',
          chefId,
          productId,
          productName: productName || product.name || 'غير معروف',
          itemId,
          eventId: `${taskId}-taskStarted`,
          items: [{
            _id: itemId,
            product: {
              _id: product._id,
              name: product.name || 'غير معروف',
              unit: product.unit || 'unit',
              department: product.department || { _id: 'unknown', name: 'غير معروف' },
            },
            assignedTo: {
              _id: chef._id,
              name: chef.name || chef.username || 'غير معروف',
              username: chef.username || 'غير معروف',
              department: chef.department || { _id: 'unknown', name: 'غير معروف' },
            },
            status: 'in_progress',
          }],
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskStarted', message, eventData.data, io, true);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task started:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleTaskCompleted = async (data) => {
    const { orderId, taskId, chefId, productName, productId, itemId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .populate({ path: 'items.product', select: 'name unit department', populate: { path: 'department', select: 'name code' } })
        .session(session);
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const product = await Product.findById(productId)
        .populate('department', 'name code')
        .session(session)
        .lean();
      if (!product) {
        console.error(`[${new Date().toISOString()}] Product not found: ${productId}`);
        return;
      }

      const chef = await User.findById(chefId)
        .select('username name department')
        .populate('department', 'name code')
        .session(session)
        .lean();
      if (!chef || chef.role !== 'chef') {
        console.error(`[${new Date().toISOString()}] Invalid chef: ${chefId}`);
        return;
      }

      const orderItem = order.items.find(item => item._id.toString() === itemId);
      if (!orderItem) {
        console.error(`[${new Date().toISOString()}] Order item not found: ${itemId}`);
        return;
      }

      const message = `تم إكمال مهمة (${productName || product.name || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'} (الفرع: ${order.branch?.name || 'غير معروف'})`;
      const eventData = {
        _id: `${taskId}-taskCompleted-${Date.now()}`,
        type: 'taskCompleted',
        message,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          taskId,
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'غير معروف',
          chefId,
          productId,
          productName: productName || product.name || 'غير معروف',
          itemId,
          eventId: `${taskId}-taskCompleted`,
          items: [{
            _id: itemId,
            product: {
              _id: product._id,
              name: product.name || 'غير معروف',
              unit: product.unit || 'unit',
              department: product.department || { _id: 'unknown', name: 'غير معروف' },
            },
            assignedTo: {
              _id: chef._id,
              name: chef.name || chef.username || 'غير معروف',
              username: chef.username || 'غير معروف',
              department: chef.department || { _id: 'unknown', name: 'غير معروف' },
            },
            status: 'completed',
          }],
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskCompleted', message, eventData.data, io, true);

      const allTasksCompleted = await ProductionAssignment.find({ order: orderId }).session(session).lean();
      const isOrderCompleted = allTasksCompleted.every(task => task.status === 'completed');

      if (isOrderCompleted && order.status === 'in_production') {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
          notes: 'All tasks completed',
        });
        await order.save({ session });

        const completionMessage = `تم اكتمال الطلب ${order.orderNumber} بالكامل`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: completionMessage,
          data: {
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            branchName: order.branch?.name || 'غير معروف',
            eventId: `${orderId}-orderCompleted`,
            items: order.items.map(item => ({
              _id: item._id,
              product: {
                _id: item.product._id,
                name: item.product.name || 'غير معروف',
                unit: item.product.unit || 'unit',
                department: item.product.department || { _id: 'unknown', name: 'غير معروف' },
              },
              quantity: item.quantity,
              status: item.status,
            })),
          },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const completionRooms = new Set(['admin', 'production', `branch-${order.branch?._id}`, `chef-${chefId}`]);
        completionRooms.forEach(room => io.to(room).emit('newNotification', completionEventData));

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        const branchUsers = await User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean();
        const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers]) {
          await createNotification(user._id, 'orderCompleted', completionMessage, completionEventData.data, io, true);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderApproved = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .session(session)
        .lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم اعتماد الطلب ${orderNumber} من ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderApproved-${Date.now()}`,
        type: 'orderApproved',
        message,
        data: {
          orderId,
          orderNumber,
          branchId: order.branch?._id || branchId,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${orderId}-orderApproved`,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderApproved', message, eventData.data, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderInTransit = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .session(session)
        .lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderInTransit-${Date.now()}`,
        type: 'orderInTransit',
        message,
        data: {
          orderId,
          orderNumber,
          branchId: order.branch?._id || branchId,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${orderId}-orderInTransit`,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderInTransit', message, eventData.data, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleOrderDelivered = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .session(session)
        .lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم توصيل الطلب ${orderNumber} إلى ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-orderDelivered-${Date.now()}`,
        type: 'orderDelivered',
        message,
        data: {
          orderId,
          orderNumber,
          branchId: order.branch?._id || branchId,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${orderId}-orderDelivered`,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderDelivered', message, eventData.data, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order delivered:`, err);
    } finally {
      session.endSession();
    }
  };

  const handleBranchConfirmedReceipt = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .session(session)
        .lean();
      if (!order) {
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const message = `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'غير معروف'}`;
      const eventData = {
        _id: `${orderId}-branchConfirmedReceipt-${Date.now()}`,
        type: 'branchConfirmedReceipt',
        message,
        data: {
          orderId,
          orderNumber,
          branchId: order.branch?._id || branchId,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${orderId}-branchConfirmedReceipt`,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'branchConfirmedReceipt', message, eventData.data, io, true);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling branch confirmed receipt:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('taskStarted', handleTaskStarted);
  socket.on('taskCompleted', handleTaskCompleted);
  socket.on('orderApproved', handleOrderApproved);
  socket.on('orderInTransit', handleOrderInTransit);
  socket.on('orderDelivered', handleOrderDelivered);
  socket.on('branchConfirmedReceipt', handleBranchConfirmedReceipt);
};

module.exports = { createNotification, setupNotifications };