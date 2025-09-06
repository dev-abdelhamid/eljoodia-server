const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const { v4: uuidv4 } = require('uuid');

const createNotification = async (userId, type, messageKey, data = {}, io, priority = 'medium') => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, messageKey, data, priority });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error('معرف المستخدم غير صالح');
    }

    const validTypes = [
      'new_order_from_branch',
      'order_approved_for_branch',
      'new_production_assigned_to_chef',
      'order_completed_by_chefs',
      'order_in_transit_to_branch',
      'order_delivered',
      'branch_confirmed_receipt',
      'return_status_updated',
      'order_status_updated',
      'task_assigned',
      'missing_assignments',
    ];

    if (!validTypes.includes(type)) {
      throw new Error(`نوع الإشعار غير صالح: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error('خطأ في تهيئة Socket.IO');
    }

    // تحسين eventId ليكون أكثر دقة
    const eventId = `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}-${Date.now()}`;
    const existingNotification = await Notification.findOne({ 
      user: userId, 
      type, 
      'data.eventId': eventId 
    }).lean();
    
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

    // تحديد الأولوية بناءً على نوع الإشعار
    const priorityMap = {
      'new_order_from_branch': 'high',
      'task_assigned': 'high',
      'missing_assignments': 'urgent',
      'order_completed_by_chefs': 'medium',
      'order_status_updated': 'medium',
      'return_status_updated': 'medium',
      'order_approved_for_branch': 'medium',
      'order_in_transit_to_branch': 'medium',
      'order_delivered': 'low',
      'branch_confirmed_receipt': 'low',
      'new_production_assigned_to_chef': 'high',
    };
    const finalPriority = priorityMap[type] || priority;

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    const notification = new Notification({
      _id: uuidv4(),
      user: userId,
      type,
      message: messageKey,
      data: { ...data, eventId, priority: finalPriority },
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
        priority: finalPriority,
      },
      read: notification.read,
      user: {
        _id: populatedNotification.user._id,
        username: populatedNotification.user.username,
        role: populatedNotification.user.role,
        branch: populatedNotification.user.branch || null,
      },
      createdAt: notification.createdAt.toISOString(),
      sound: `${baseUrl}/sounds/notification.mp3`,
      soundType: 'notification',
      vibrate: finalPriority === 'urgent' ? [300, 100, 300] : [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    // تحديد الغرف بناءً على الأدوار
    const rooms = new Set([`user-${userId}`]);
    if (targetUser.role === 'admin') rooms.add('admin');
    if (targetUser.role === 'production' && targetUser.department?._id) rooms.add(`department-${targetUser.department._id}`);
    if (targetUser.role === 'branch' && targetUser.branch?._id) rooms.add(`branch-${targetUser.branch._id}`);
    if (targetUser.role === 'chef' && data.chefId) rooms.add(`chef-${data.chefId}`);
    if (data.branchId) rooms.add(`branch-${data.branchId}`);
    if (data.departmentId) rooms.add(`department-${data.departmentId}`);

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
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

const setupNotifications = (io, socket) => {
  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId)
        .populate('branch', 'name')
        .populate('items.product', 'department')
        .session(session)
        .lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }

      const branchMessageKey = 'notifications.order_created_success';
      const adminProductionMessageKey = 'notifications.new_order_from_branch';
      const eventId = `${orderId}-new_order_from_branch`;

      const baseEventData = {
        orderId,
        orderNumber,
        branchId,
        branchName: order.branch?.name || 'Unknown',
        eventId,
      };

      // جلب المستخدمين باستخدام استعلام مجمع لتحسين الأداء
      const users = await User.aggregate([
        {
          $match: {
            $or: [
              { role: 'admin' },
              { role: 'production', department: { $in: order.items.map(item => item.product?.department?._id).filter(id => id) } },
              { role: 'branch', branch: branchId ? mongoose.Types.ObjectId(branchId) : null },
            ],
          },
        },
        { $project: { _id: 1, role: 1, branch: 1, department: 1 } },
      ]);

      const branchUsers = users.filter(u => u.role === 'branch' && u.branch?.toString() === branchId);
      const adminUsers = users.filter(u => u.role === 'admin');
      const productionUsers = users.filter(u => u.role === 'production');

      // إرسال الإشعارات للمستخدمين المناسبين
      const notificationsPromises = [];
      for (const user of branchUsers) {
        notificationsPromises.push(
          createNotification(user._id, 'new_order_from_branch', branchMessageKey, baseEventData, io, 'high')
        );
      }
      for (const user of [...adminUsers, ...productionUsers]) {
        notificationsPromises.push(
          createNotification(user._id, 'new_order_from_branch', adminProductionMessageKey, baseEventData, io, 'high')
        );
      }

      await Promise.all(notificationsPromises);

      // إرسال إشعارات إلى الغرف
      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => {
        const eventData = {
          _id: `${orderId}-orderCreated-${room}-${Date.now()}`,
          type: 'new_order_from_branch',
          message: room === `branch-${branchId}` ? branchMessageKey : adminProductionMessageKey,
          data: { ...baseEventData, priority: 'high' },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          soundType: 'notification',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };
        io.to(room).emit('newNotification', eventData);
        console.log(`[${new Date().toISOString()}] Emitted to room ${room}:`, eventData);
      });

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, err);
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
};

module.exports = { createNotification, setupNotifications };