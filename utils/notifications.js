const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

const createNotification = async (userId, event, message, data = {}, io) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { event, message, data });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('Invalid userId');
    }

    const validEvents = [
      'order_created',
      'order_approved',
      'task_assigned',
      'task_completed',
      'order_confirmed',
      'order_in_transit',
      'order_delivered',
      'return_status_updated',
      'missing_assignments',
    ];

    if (!validEvents.includes(event)) {
      throw new Error(`Invalid event: ${event}`);
    }

    if (!io || typeof io.of !== 'function') {
      throw new Error('Invalid Socket.IO instance');
    }

    const eventId = `${data.orderId || data.taskId || data.returnId}-${event}-${userId}`;
    const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
    if (existingNotification) {
      console.warn(`[${new Date().toISOString()}] Duplicate notification detected: ${eventId}`);
      return existingNotification;
    }

    const targetUser = await User.findById(userId)
      .select('username role branchId departmentId')
      .lean();

    if (!targetUser) {
      throw new Error('User not found');
    }

    const typeMap = {
      order_created: 'info',
      order_approved: 'success',
      task_assigned: 'info',
      task_completed: 'success',
      order_confirmed: 'success',
      order_in_transit: 'info',
      order_delivered: 'success',
      return_status_updated: data.status === 'approved' ? 'success' : 'warning',
      missing_assignments: 'warning',
    };

    const notification = new Notification({
      user: userId,
      type: typeMap[event] || 'info',
      event,
      message: message.trim(),
      data: { ...data, eventId },
      read: false,
    });

    await notification.save();

    const populatedNotification = await Notification.findById(notification._id)
      .select('user type event message data read createdAt')
      .populate('user', 'username role branchId departmentId')
      .lean();

    const eventData = {
      _id: notification._id,
      type: notification.type,
      event: notification.event,
      message: notification.message,
      data: {
        ...notification.data,
        branchId: data.branchId || targetUser.branchId,
        departmentId: data.departmentId || targetUser.departmentId,
        chefId: data.chefId,
      },
      read: notification.read,
      user: {
        _id: populatedNotification.user._id,
        username: populatedNotification.user.username,
        role: populatedNotification.user.role,
        branchId: populatedNotification.user.branchId,
        departmentId: populatedNotification.user.departmentId,
      },
      createdAt: notification.createdAt,
      sound: notification.sound,
      vibrate: notification.vibrate,
    };

    const rooms = [
      `user-${userId}`,
      targetUser.role,
      ...(targetUser.branchId ? [`branch-${targetUser.branchId}`] : []),
      ...(targetUser.departmentId ? [`department-${targetUser.departmentId}`] : []),
      ...(data.chefId ? [`chef-${data.chefId}`] : []),
      ...(data.branchId ? [`branch-${data.branchId}`] : []),
      ...(data.departmentId ? [`department-${data.departmentId}`] : []),
    ];

    rooms.forEach((room) => {
      io.of('/api').to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
    });

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
    throw err;
  }
};

const setupNotifications = (io, socket) => {
  const handleEvent = async (event, data) => {
    try {
      const { orderId, returnId, taskId, branchId, chefId, departmentId, orderNumber, productName, status } = data;
      let order, rooms = new Set(['admin', 'production']);
      if (orderId) {
        order = await Order.findById(orderId).select('orderNumber branch').lean();
        if (order?.branch) rooms.add(`branch-${order.branch}`);
      }

      const eventConfig = {
        order_created: {
          message: `New order ${order?.orderNumber || orderNumber} from branch`,
          rooms: [branchId ? `branch-${branchId}` : null].filter(Boolean),
          users: ['admin', 'production', branchId ? { role: 'branch', branchId } : null],
        },
        order_approved: {
          message: `Order ${order?.orderNumber || orderNumber} approved for branch`,
          rooms: [branchId ? `branch-${branchId}` : null].filter(Boolean),
          users: ['admin', 'production', branchId ? { role: 'branch', branchId } : null],
        },
        task_assigned: {
          message: `New task assigned for ${productName || 'item'} in order ${order?.orderNumber || orderNumber}`,
          rooms: [chefId ? `chef-${chefId}` : null, departmentId ? `department-${departmentId}` : null].filter(
            Boolean
          ),
          users: ['admin', 'production', chefId ? { _id: chefId } : null, branchId ? { role: 'branch', branchId } : null],
        },
        task_completed: {
          message: `Task (${productName || 'item'}) completed in order ${order?.orderNumber || orderNumber}`,
          rooms: [chefId ? `chef-${chefId}` : null, departmentId ? `department-${departmentId}` : null].filter(
            Boolean
          ),
          users: ['admin', 'production', branchId ? { role: 'branch', branchId } : null],
        },
        order_confirmed: {
          message: `Order ${order?.orderNumber || orderNumber} confirmed by branch`,
          rooms: [branchId ? `branch-${branchId}` : null].filter(Boolean),
          users: ['admin', 'production', branchId ? { role: 'branch', branchId } : null],
        },
        order_in_transit: {
          message: `Order ${order?.orderNumber || orderNumber} is in transit`,
          rooms: [branchId ? `branch-${branchId}` : null].filter(Boolean),
          users: ['admin', 'production', branchId ? { role: 'branch', branchId } : null],
        },
        order_delivered: {
          message: `Order ${order?.orderNumber || orderNumber} delivered to branch`,
          rooms: [branchId ? `branch-${branchId}` : null].filter(Boolean),
          users: ['admin', 'production', branchId ? { role: 'branch', branchId } : null],
        },
        return_status_updated: {
          message: `Return for order ${order?.orderNumber || orderNumber} ${
            status === 'approved' ? 'approved' : 'rejected'
          }`,
          rooms: [branchId ? `branch-${branchId}` : null].filter(Boolean),
          users: ['admin', 'production', branchId ? { role: 'branch', branchId } : null],
        },
        missing_assignments: {
          message: `Missing assignments for order ${order?.orderNumber || orderNumber}`,
          rooms: [],
          users: ['admin', 'production'],
        },
      };

      if (!eventConfig[event]) return;

      const { message, rooms: additionalRooms, users: userQueries } = eventConfig[event];
      rooms = new Set([...rooms, ...additionalRooms]);

      const eventData = {
        _id: `${orderId || returnId || taskId}-${event}-${Date.now()}`,
        type: event.includes('error') || event === 'missing_assignments' ? 'warning' : event.includes('completed') || event.includes('approved') || event.includes('delivered') ? 'success' : 'info',
        event,
        message,
        data: {
          orderId,
          returnId,
          taskId,
          branchId,
          chefId,
          departmentId,
          productName,
          orderNumber: order?.orderNumber || orderNumber,
          status,
          eventId: `${orderId || returnId || taskId}-${event}`,
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      };

      rooms.forEach((room) => io.of('/api').to(room).emit('newNotification', eventData));

      const users = [];
      for (const query of userQueries.filter(Boolean)) {
        if (typeof query === 'string') {
          users.push(...(await User.find({ role: query }).select('_id').lean()));
        } else {
          users.push(...(await User.find(query).select('_id').lean()));
        }
      }

      await Promise.all(users.map((user) => createNotification(user._id, event, message, eventData.data, io)));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error handling ${event}:`, err);
    }
  };

  [
    'order_created',
    'order_approved',
    'task_assigned',
    'task_completed',
    'order_confirmed',
    'order_in_transit',
    'order_delivered',
    'return_status_updated',
    'missing_assignments',
  ].forEach((event) => socket.on(event, (data) => handleEvent(event, data)));
};

module.exports = { createNotification, setupNotifications };