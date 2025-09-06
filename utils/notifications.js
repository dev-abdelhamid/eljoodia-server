const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const ProductionAssignment = require('../models/ProductionAssignment');
const { v4: uuidv4 } = require('uuid');

const createNotification = async (userId, type, messageKey, data = {}, io, retryCount = 3) => {
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`[${new Date().toISOString()}] Creating notification (attempt ${attempt}) for user ${userId}:`, { type, messageKey, data });

      if (!mongoose.isValidObjectId(userId)) {
        throw new Error(`معرف المستخدم غير صالح: ${userId}`);
      }

      const validTypes = [
        'order_created',
        'order_status_updated',
        'item_status_updated',
        'order_completed',
        'order_delivered',
        'return_created',
        'return_status_updated',
        'task_assigned',
        'task_completed',
      ];

      if (!validTypes.includes(type)) {
        throw new Error(`نوع الإشعار غير صالح: ${type}`);
      }

      if (!io || typeof io.to !== 'function') {
        throw new Error('خطأ في تهيئة Socket.IO');
      }

      const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}`;
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
      if (existingNotification) {
        console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
        return existingNotification;
      }

      const targetUser = await User.findById(userId)
        .select('username role branch department')
        .populate('branch', 'name')
        .lean();

      if (!targetUser) {
        throw new Error('المستخدم غير موجود');
      }

      const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
      const soundTypeMap = {
        order_created: 'order-created',
        order_status_updated: 'status-updated',
        item_status_updated: 'status-updated',
        order_completed: 'order-completed',
        order_delivered: 'order-delivered',
        return_created: 'return-created',
        return_status_updated: 'return-status-updated',
        task_assigned: 'task-assigned',
        task_completed: 'task-completed',
      };

      const soundType = soundTypeMap[type] || 'notification';
      const notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: messageKey,
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });

      await notification.save();

      const populatedNotification = await Notification.findById(notification._id)
        .populate('user', 'username role branch')
        .lean();

      const eventData = {
        _id: notification._id,
        type: notification.type,
        message: messageKey,
        data: {
          ...notification.data,
          branchId: data.branchId || targetUser.branch?._id?.toString(),
          taskId: data.taskId,
          orderId: data.orderId,
          chefId: data.chefId,
        },
        read: notification.read,
        user: {
          _id: populatedNotification.user._id,
          username: populatedNotification.user.username,
          role: populatedNotification.user.role,
          branch: populatedNotification.user.branch || null,
        },
        createdAt: notification.createdAt.toISOString(),
        sound: `${baseUrl}/sounds/${soundType}.mp3`,
        soundType,
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set([`user-${userId}`]);
      if (targetUser.role === 'admin') rooms.add('admin');
      if (targetUser.role === 'production') rooms.add('production');
      if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.add(`branch-${targetUser.branch._id}`);
      if (targetUser.role === 'chef' && data.chefId) rooms.add(`chef-${data.chefId}`);
      if (data.branchId) rooms.add(`branch-${data.branchId}`);
      if (data.departmentId) rooms.add(`department-${data.departmentId}`);

      rooms.forEach(room => {
        io.to(room).emit(type, eventData);
        console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
      });

      return notification;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error creating notification (attempt ${attempt}):`, {
        message: err.message,
        stack: err.stack,
        userId,
        type,
        data,
      });
      if (attempt === retryCount) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
};

const setupNotifications = (io, socket) => {
  const handleOrderCreated = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) throw new Error(`الطلب ${orderId} غير موجود`);

      const messageKey = 'socket.order_created';
      const eventId = `${orderId}-order_created`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'order_created',
        message: messageKey,
        data: { orderId, orderNumber, branchId, branchName: order.branch?.name || 'غير معروف', eventId },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/order-created.mp3',
        soundType: 'order-created',
        vibrate: [300, 100, 300],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('orderCreated', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'order_created', messageKey, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, {
        error: err.message,
        stack: err.stack,
        data,
      });
    } finally {
      session.endSession();
    }
  };

  const handleOrderApproved = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) throw new Error(`الطلب ${orderId} غير موجود`);

      const messageKey = 'socket.order_status_updated';
      const eventId = `${orderId}-order_status_updated-approved`;
      const eventData = {
        _id: `${orderId}-orderApproved-${Date.now()}`,
        type: 'order_status_updated',
        message: messageKey,
        data: { orderId, orderNumber, branchId, branchName: order.branch?.name || 'غير معروف', status: 'approved', eventId },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/status-updated.mp3',
        soundType: 'status-updated',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('orderStatusUpdated', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'order_status_updated', messageKey, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, {
        error: err.message,
        stack: err.stack,
        data,
      });
    } finally {
      session.endSession();
    }
  };

  const handleTaskAssigned = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, tasks } = data; // تعديل لدعم المهام المتعددة
      if (!mongoose.isValidObjectId(orderId) || !Array.isArray(tasks)) {
        throw new Error('معرف الطلب أو المهام غير صالحة');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) throw new Error(`الطلب ${orderId} غير موجود`);

      const messageKey = 'socket.task_assigned';
      const eventId = `${orderId}-task_assigned-${Date.now()}`;
      const eventData = {
        _id: `${orderId}-taskAssigned-${Date.now()}`,
        type: 'task_assigned',
        message: messageKey,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'غير معروف',
          tasks: tasks.map(task => ({
            taskId: task.taskId,
            chefId: task.chefId,
            productId: task.productId,
            productName: task.productName,
            quantity: task.quantity,
            eventId: `${task.taskId}-task_assigned`,
          })),
          eventId,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/task-assigned.mp3',
        soundType: 'task-assigned',
        vibrate: [400, 100, 400],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${order.branch?._id}`]);
      tasks.forEach(task => rooms.add(`chef-${task.chefId}`));
      rooms.forEach(room => io.to(room).emit('task_assigned', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const chefUsers = await User.find({ _id: { $in: tasks.map(t => t.chefId) } }).select('_id').lean();
      const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

      for (const user of [...adminUsers, ...productionUsers, ...chefUsers, ...branchUsers]) {
        await createNotification(user._id, 'task_assigned', messageKey, eventData.data, io);
      }

      // إرسال itemStatusUpdated لكل مهمة
      for (const task of tasks) {
        const itemEventData = {
          _id: `${task.taskId}-itemStatusUpdated-${Date.now()}`,
          type: 'item_status_updated',
          message: 'socket.item_status_updated',
          data: {
            orderId,
            itemId: task.taskId,
            status: 'assigned',
            productName: task.productName,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            branchName: order.branch?.name || 'غير معروف',
            eventId: `${task.taskId}-item_status_updated`,
          },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/status-updated.mp3',
          soundType: 'status-updated',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };
        rooms.forEach(room => io.to(room).emit('itemStatusUpdated', itemEventData));
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, {
        error: err.message,
        stack: err.stack,
        data,
      });
    } finally {
      session.endSession();
    }
  };

  const handleTaskCompleted = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, taskId, chefId, productName } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId) || !mongoose.isValidObjectId(chefId)) {
        throw new Error('معرف الطلب، المهمة، أو الشيف غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session);
      if (!order) throw new Error(`الطلب ${orderId} غير موجود`);

      const messageKey = 'socket.task_completed';
      const eventId = `${taskId}-task_completed`;
      const eventData = {
        _id: `${orderId}-taskCompleted-${Date.now()}`,
        type: 'task_completed',
        message: messageKey,
        data: {
          orderId,
          taskId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'غير معروف',
          chefId,
          productName,
          eventId,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/task-completed.mp3',
        soundType: 'task-completed',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const allTasksCompleted = await ProductionAssignment.find({ order: orderId }).session(session).lean();
      const isOrderCompleted = allTasksCompleted.every(task => task.status === 'completed' || task._id.toString() === taskId);

      if (isOrderCompleted) {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
        });
        await order.save({ session });
      }

      const rooms = new Set(['admin', 'production', `chef-${chefId}`, `branch-${order.branch?._id}`]);
      rooms.forEach(room => io.to(room).emit('task_completed', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'task_completed', messageKey, eventData.data, io);
      }

      const itemEventData = {
        _id: `${taskId}-itemStatusUpdated-${Date.now()}`,
        type: 'item_status_updated',
        message: 'socket.item_status_updated',
        data: {
          orderId,
          itemId: taskId,
          status: 'completed',
          productName,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${taskId}-item_status_updated`,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/status-updated.mp3',
        soundType: 'status-updated',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };
      rooms.forEach(room => io.to(room).emit('itemStatusUpdated', itemEventData));

      if (isOrderCompleted) {
        const completionMessageKey = 'socket.order_completed';
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'order_completed',
          message: completionMessageKey,
          data: {
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            branchName: order.branch?.name || 'غير معروف',
            eventId: `${orderId}-order_completed`,
          },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/order-completed.mp3',
          soundType: 'order-completed',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        rooms.forEach(room => io.to(room).emit('orderCompleted', completionEventData));

        for (const user of [...adminUsers, ...productionUsers]) {
          await createNotification(user._id, 'order_completed', completionMessageKey, completionEventData.data, io);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, {
        error: err.message,
        stack: err.stack,
        data,
      });
    } finally {
      session.endSession();
    }
  };

  const handleOrderInTransit = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) throw new Error(`الطلب ${orderId} غير موجود`);

      const messageKey = 'socket.order_status_updated';
      const eventId = `${orderId}-order_status_updated-in_transit`;
      const eventData = {
        _id: `${orderId}-orderInTransit-${Date.now()}`,
        type: 'order_status_updated',
        message: messageKey,
        data: {
          orderId,
          orderNumber,
          branchId,
          branchName: order.branch?.name || 'غير معروف',
          status: 'in_transit',
          eventId,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/status-updated.mp3',
        soundType: 'status-updated',
        vibrate: [300, 100, 300],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('orderStatusUpdated', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'order_status_updated', messageKey, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, {
        error: err.message,
        stack: err.stack,
        data,
      });
    } finally {
      session.endSession();
    }
  };

  const handleOrderConfirmed = async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(branchId)) {
        throw new Error('معرف الطلب أو الفرع غير صالح');
      }

      const order = await Order.findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) throw new Error(`الطلب ${orderId} غير موجود`);

      const messageKey = 'socket.order_delivered';
      const eventId = `${orderId}-order_delivered`;
      const eventData = {
        _id: `${orderId}-orderDelivered-${Date.now()}`,
        type: 'order_delivered',
        message: messageKey,
        data: {
          orderId,
          orderNumber,
          branchId,
          branchName: order.branch?.name || 'غير معروف',
          eventId,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/order-delivered.mp3',
        soundType: 'order-delivered',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('orderDelivered', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'order_delivered', messageKey, eventData.data, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order confirmed:`, {
        error: err.message,
        stack: err.stack,
        data,
      });
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('orderApproved', handleOrderApproved);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('taskCompleted', handleTaskCompleted);
  socket.on('orderInTransit', handleOrderInTransit);
  socket.on('orderDelivered', handleOrderConfirmed);
};

module.exports = { createNotification, setupNotifications };