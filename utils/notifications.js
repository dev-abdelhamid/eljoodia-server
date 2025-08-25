// utils/notifications.js
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const Branch = require('../models/Branch');

/**
 * Valid notification types for consistency and validation
 */
const validTypes = [
  'new_order_from_branch',
  'branch_confirmed_receipt',
  'new_order_for_production',
  'order_completed_by_chefs',
  'order_approved_for_branch',
  'order_in_transit_to_branch',
  'new_production_assigned_to_chef',
  'order_status_updated',
  'task_assigned',
  'order_completed',
  'order_delivered',
  'return_status_updated',
  'missing_assignments',
];

/**
 * Creates a notification for a specific user and emits it via Socket.IO
 * @param {string} userId - The ID of the user to receive the notification
 * @param {string} type - The type of notification (must be in validTypes)
 * @param {string} message - The notification message
 * @param {object} data - Additional data for the notification
 * @param {object} io - Socket.IO instance
 * @returns {Promise<object>} The created notification
 */
const createNotification = async (userId, type, message, data = {}, io) => {
  try {
    // Validate inputs
    if (!mongoose.isValidObjectId(userId)) {
      throw new Error(`معرف المستخدم غير صالح: ${userId}`);
    }

    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.of !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    // Fetch user with necessary fields
    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();

    if (!targetUser) {
      throw new Error(`المستخدم غير موجود: ${userId}`);
    }

    // Create notification
    const notification = new Notification({
      user: userId,
      type,
      message: message.trim(),
      data,
      read: false,
      createdAt: new Date(),
    });

    await notification.save();

    // Prepare event data for Socket.IO
    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia.vercel.app';
    const eventData = {
      _id: notification._id.toString(),
      type: notification.type,
      message: notification.message,
      data: {
        ...data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        departmentId: data.departmentId || targetUser.department?._id?.toString(),
        taskId: data.taskId,
        orderId: data.orderId,
        chefId: data.chefId,
      },
      read: notification.read,
      user: {
        _id: userId,
        username: targetUser.username,
        role: targetUser.role,
        branch: targetUser.branch || null,
        department: targetUser.department || null,
      },
      createdAt: notification.createdAt.toISOString(),
      sound: `${baseUrl}/sounds/notification.mp3`, // Unified sound
      vibrate: [200, 100, 200], // Unified vibration pattern
      timestamp: new Date().toISOString(), // Gregorian timestamp
    };

    // Determine rooms for Socket.IO emission
    const rooms = [`user-${userId}`];
    if (targetUser.role) rooms.push(targetUser.role);
    if (targetUser.branch?._id) rooms.push(`branch-${targetUser.branch._id}`);
    if (targetUser.department?._id) rooms.push(`department-${targetUser.department._id}`);
    if (data.branchId) rooms.push(`branch-${data.branchId}`);
    if (data.departmentId) rooms.push(`department-${data.departmentId}`);
    if (data.chefId) rooms.push(`chef-${data.chefId}`);
    rooms.push('all-departments');

    // Emit notification to rooms
    rooms.forEach(room => {
      io.of('/api').to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, {
        type,
        userId,
        message,
      });
    });

    return notification;
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

/**
 * Notifies users based on roles and optional branch/department filters
 * @param {string[]} roles - Array of roles to notify
 * @param {string|null} branchId - Optional branch ID to filter branch users
 * @param {string|null} departmentId - Optional department ID to filter chef users
 * @param {string} type - Notification type
 * @param {string} message - Notification message
 * @param {object} data - Notification data
 * @param {object} io - Socket.IO instance
 */
const notifyUsersByRoles = async (roles, branchId = null, departmentId = null, type, message, data, io) => {
  try {
    const query = { $or: [] };

    // Add global roles (admin, production, etc.)
    const globalRoles = roles.filter(r => r !== 'branch' && r !== 'chef');
    if (globalRoles.length > 0) {
      query.$or.push({ role: { $in: globalRoles } });
    }

    // Add branch-specific users
    if (roles.includes('branch') && branchId && mongoose.isValidObjectId(branchId)) {
      query.$or.push({ role: 'branch', branch: branchId });
    }

    // Add chef-specific users by department
    if (roles.includes('chef') && departmentId && mongoose.isValidObjectId(departmentId)) {
      query.$or.push({ role: 'chef', department: departmentId });
    }

    if (query.$or.length === 0) {
      console.warn(`[${new Date().toISOString()}] No valid roles or filters provided for notification`, { roles, branchId, departmentId });
      return;
    }

    const users = await User.find(query).select('_id').lean();

    await Promise.all(users.map(user => 
      createNotification(user._id, type, message, data, io)
    ));

    console.log(`[${new Date().toISOString()}] Notified ${users.length} users for type: ${type}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error notifying users by roles:`, {
      message: err.message,
      stack: err.stack,
      roles,
      branchId,
      departmentId,
      type,
    });
  }
};

/**
 * Notifies specific users with customizable message and data
 * @param {string[]} userIds - Array of user IDs to notify
 * @param {string} type - Notification type
 * @param {string|Function} messageGetter - Message or function to generate message
 * @param {object|Function} dataGetter - Data or function to generate data
 * @param {object} io - Socket.IO instance
 */
const notifySpecificUsers = async (userIds, type, messageGetter, dataGetter, io) => {
  try {
    const validUserIds = userIds.filter(id => mongoose.isValidObjectId(id));
    if (validUserIds.length !== userIds.length) {
      console.warn(`[${new Date().toISOString()}] Invalid user IDs filtered out:`, {
        invalidIds: userIds.filter(id => !mongoose.isValidObjectId(id)),
      });
    }

    await Promise.all(validUserIds.map(async (userId) => {
      const message = typeof messageGetter === 'function' ? messageGetter(userId) : messageGetter;
      const data = typeof dataGetter === 'function' ? dataGetter(userId) : dataGetter;
      await createNotification(userId, type, message, data, io);
    }));

    console.log(`[${new Date().toISOString()}] Notified ${validUserIds.length} specific users for type: ${type}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error notifying specific users:`, {
      message: err.message,
      stack: err.stack,
      type,
      userIds,
    });
  }
};

/**
 * Sets up Socket.IO event listeners for notifications
 * @param {object} io - Socket.IO instance
 * @param {object} socket - Socket instance
 */
const setupNotifications = (io, socket) => {
  // No client-to-server listeners needed based on current requirements
  // If future requirements demand specific client-emitted events, add them here
  console.log(`[${new Date().toISOString()}] Notification setup initialized for socket: ${socket.id}`);
};

module.exports = {
  createNotification,
  notifyUsersByRoles,
  notifySpecificUsers,
  setupNotifications,
};