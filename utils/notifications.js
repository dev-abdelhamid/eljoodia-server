const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');

/**
 * إنشاء إشعار وإرساله عبر Socket.IO
 * @param {string} userId - معرف المستخدم
 * @param {string} type - نوع الإشعار
 * @param {string} message - رسالة الإشعار
 * @param {Object} data - بيانات إضافية
 * @param {Object} io - كائن Socket.IO
 * @param {boolean} saveToDb - هل يتم حفظ الإشعار في قاعدة البيانات
 * @returns {Object} الإشعار الذي تم إنشاؤه
 */
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
      'taskCompleted',
      'orderStatusUpdated',
      'itemStatusUpdated',
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
      .populate('branch', 'name')
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
      : {
          _id: uuidv4(),
          user: targetUser,
          type,
          message,
          data: { ...data, eventId },
          read: false,
          createdAt: new Date(),
        };

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

    const roleRooms = {
      orderCreated: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`],
      orderCompleted: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`, `chef-${data.chefId}`],
      taskAssigned: ['admin', 'production', `chef-${data.chefId}`],
      orderApproved: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`],
      orderInTransit: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`],
      orderDelivered: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`],
      branchConfirmedReceipt: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`],
      taskStarted: ['admin', 'production', `chef-${data.chefId}`],
      taskCompleted: ['admin', 'production', `chef-${data.chefId}`],
      orderStatusUpdated: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`, `chef-${data.chefId}`],
      itemStatusUpdated: ['admin', 'production', `branch-${data.branchId || targetUser.branch?._id}`, `chef-${data.chefId}`],
    }[type] || [];

    const rooms = new Set([`user-${userId}`, ...roleRooms.filter(room => room && !room.includes('undefined'))]);
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

/**
 * إرسال حدث Socket.IO إلى غرف محددة
 * @param {Object} io - كائن Socket.IO
 * @param {string[]} rooms - قائمة الغرف
 * @param {string} eventName - اسم الحدث
 * @param {Object} eventData - بيانات الحدث
 */
const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = new Set(rooms.filter(room => room && !room.includes('undefined')));
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
    eventData: eventDataWithSound,
  });
};

/**
 * إشعار المستخدمين
 * @param {Object} io - كائن Socket.IO
 * @param {Object[]} users - قائمة المستخدمين
 * @param {string} type - نوع الإشعار
 * @param {string} message - رسالة الإشعار
 * @param {Object} data - بيانات إضافية
 * @param {boolean} saveToDb - هل يتم حفظ الإشعار
 */
const notifyUsers = async (io, users, type, message, data, saveToDb = false) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

/**
 * معالجة عامة للأحداث
 * @param {Object} io - كائن Socket.IO
 * @param {Object} data - بيانات الحدث
 * @param {string} type - نوع الحدث
 * @param {Function} messageGenerator - دالة لتوليد الرسالة
 * @param {Object} extraData - بيانات إضافية
 * @param {boolean} saveToDb - هل يتم حفظ الإشعار
 */
const handleEvent = async (io, data, type, messageGenerator, extraData = {}, saveToDb = false) => {
  try {
    const { orderId, branchId, chefId } = data;
    let message, eventData;

    if (orderId) {
      const order = await Order.findById(orderId).populate('branch', 'name').lean();
      if (!order) {
        console.warn(`[${new Date().toISOString()}] Order not found: ${orderId}`);
        return;
      }
      message = messageGenerator(order, data);
      eventData = {
        _id: `${orderId}-${type}-${Date.now()}`,
        type,
        message,
        data: { orderId, branchId: order.branch?._id || branchId, ...extraData, eventId: `${orderId || extraData.taskId || 'generic'}-${type}` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };
    } else {
      message = messageGenerator(null, data);
      eventData = {
        _id: `${extraData.taskId || 'generic'}-${type}-${Date.now()}`,
        type,
        message,
        data: { ...extraData, eventId: `${extraData.taskId || 'generic'}-${type}` },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };
    }

    const roleRooms = {
      orderCreated: ['admin', 'production', `branch-${branchId}`],
      orderCompleted: ['admin', 'production', `branch-${branchId}`, `chef-${chefId}`],
      taskAssigned: ['admin', 'production', `chef-${chefId}`],
      orderApproved: ['admin', 'production', `branch-${branchId}`],
      orderInTransit: ['admin', 'production', `branch-${branchId}`],
      orderDelivered: ['admin', 'production', `branch-${branchId}`],
      branchConfirmedReceipt: ['admin', 'production', `branch-${branchId}`],
      taskStarted: ['admin', 'production', `chef-${chefId}`],
      taskCompleted: ['admin', 'production', `chef-${chefId}`],
      orderStatusUpdated: ['admin', 'production', `branch-${branchId}`, `chef-${chefId}`],
      itemStatusUpdated: ['admin', 'production', `branch-${branchId}`, `chef-${chefId}`],
    }[type] || [];

    await emitSocketEvent(io, roleRooms, type, eventData);

    const roles = {
      orderCreated: ['admin', 'production', 'branch'],
      orderCompleted: ['admin', 'production', 'branch', 'chef'],
      taskAssigned: ['admin', 'production', 'chef'],
      orderApproved: ['admin', 'production', 'branch'],
      orderInTransit: ['admin', 'production', 'branch'],
      orderDelivered: ['admin', 'production', 'branch'],
      branchConfirmedReceipt: ['admin', 'production', 'branch'],
      taskStarted: ['admin', 'production', 'chef'],
      taskCompleted: ['admin', 'production', 'chef'],
      orderStatusUpdated: ['admin', 'production', 'branch', 'chef'],
      itemStatusUpdated: ['admin', 'production', 'branch', 'chef'],
    }[type] || [];

    const users = await User.find({
      $or: [
        { role: { $in: roles.filter(r => r !== 'branch' && r !== 'chef') } },
        { role: 'branch', branch: branchId },
        { role: 'chef', _id: chefId },
      ],
    }).select('_id').lean();

    await notifyUsers(io, users, type, message, eventData.data, saveToDb);

    if (type === 'taskCompleted' && orderId) {
      const allTasksCompleted = await mongoose.model('ProductionAssignment').find({ order: orderId }).lean();
      const isOrderCompleted = allTasksCompleted.every(task => task.status === 'completed');

      if (isOrderCompleted) {
        const order = await Order.findById(orderId).populate('branch', 'name').lean();
        const completionMessage = `تم اكتمال الطلب ${order.orderNumber} بالكامل`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: completionMessage,
          data: { orderId, branchId: order.branch?._id, eventId: `${orderId}-orderCompleted` },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const completionRooms = new Set(['admin', 'production', `branch-${order.branch?._id}`, `chef-${chefId}`]);
        await emitSocketEvent(io, completionRooms, 'orderCompleted', completionEventData);

        const completionUsers = await User.find({
          $or: [
            { role: { $in: ['admin', 'production'] } },
            { role: 'branch', branch: order.branch?._id },
            { role: 'chef', _id: chefId },
          ],
        }).select('_id').lean();

        await notifyUsers(io, completionUsers, 'orderCompleted', completionMessage, completionEventData.data, saveToDb);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error handling ${type}:`, err);
  }
};

/**
 * إعداد معالجات الأحداث لـ Socket.IO
 * @param {Object} io - كائن Socket.IO
 * @param {Object} socket - كائن الـ Socket
 */
const setupNotifications = (io, socket) => {
  const eventHandlers = {
    orderCreated: {
      messageGenerator: (order, data) => `طلب جديد ${data.orderNumber} من ${order?.branch?.name || 'غير معروف'}`,
      extraData: ({ orderId, orderNumber, branchId }) => ({ orderId, orderNumber, branchId }),
      saveToDb: false,
    },
    taskAssigned: {
      messageGenerator: (order, data) =>
        `تم تعيينك لإنتاج ${data.productName || 'غير معروف'} في الطلب ${order?.orderNumber || 'غير معروف'}`,
      extraData: ({ orderId, taskId, chefId, productId, productName, quantity, branchId }) => ({
        orderId,
        taskId,
        chefId,
        productId,
        productName,
        quantity,
        branchId,
      }),
      saveToDb: false,
    },
    orderApproved: {
      messageGenerator: (order, data) => `تم اعتماد الطلب ${data.orderNumber} من ${order?.branch?.name || 'غير معروف'}`,
      extraData: ({ orderId, orderNumber, branchId }) => ({ orderId, orderNumber, branchId }),
      saveToDb: false,
    },
    orderInTransit: {
      messageGenerator: (order, data) => `الطلب ${data.orderNumber} في طريقه إلى ${order?.branch?.name || 'غير معروف'}`,
      extraData: ({ orderId, orderNumber, branchId }) => ({ orderId, orderNumber, branchId }),
      saveToDb: false,
    },
    orderDelivered: {
      messageGenerator: (order, data) => `تم توصيل الطلب ${data.orderNumber} إلى ${order?.branch?.name || 'غير معروف'}`,
      extraData: ({ orderId, orderNumber, branchId }) => ({ orderId, orderNumber, branchId }),
      saveToDb: false,
    },
    branchConfirmedReceipt: {
      messageGenerator: (order, data) => `تم تأكيد استلام الطلب ${data.orderNumber} بواسطة ${order?.branch?.name || 'غير معروف'}`,
      extraData: ({ orderId, orderNumber, branchId }) => ({ orderId, orderNumber, branchId }),
      saveToDb: false,
    },
    taskStarted: {
      messageGenerator: (order, data) =>
        `بدأ الشيف العمل على (${data.productName || 'غير معروف'}) في الطلب ${order?.orderNumber || 'غير معروف'}`,
      extraData: ({ orderId, taskId, chefId, productName }) => ({ orderId, taskId, chefId, productName }),
      saveToDb: false,
    },
    taskCompleted: {
      messageGenerator: (order, data) =>
        `تم إكمال مهمة (${data.productName || 'غير معروف'}) في الطلب ${order?.orderNumber || 'غير معروف'}`,
      extraData: ({ orderId, taskId, chefId, productName }) => ({ orderId, taskId, chefId, productName }),
      saveToDb: false,
    },
    orderStatusUpdated: {
      messageGenerator: (order, data) =>
        `تم تحديث حالة الطلب ${data.orderNumber || order?.orderNumber} إلى ${data.status}`,
      extraData: ({ orderId, orderNumber, branchId, status }) => ({ orderId, orderNumber, branchId, status }),
      saveToDb: false,
    },
    itemStatusUpdated: {
      messageGenerator: (order, data) =>
        `تم تحديث حالة العنصر ${data.productName || 'غير معروف'} في الطلب ${order?.orderNumber || 'غير معروف'} إلى ${data.status}`,
      extraData: ({ orderId, taskId, chefId, productName, status, itemId }) => ({
        orderId,
        taskId,
        chefId,
        productName,
        status,
        itemId,
      }),
      saveToDb: false,
    },
  };

  Object.entries(eventHandlers).forEach(([event, { messageGenerator, extraData, saveToDb }]) => {
    socket.on(event, async data => {
      await handleEvent(io, data, event, messageGenerator, extraData(data), saveToDb);
    });
  });
};

module.exports = { createNotification, emitSocketEvent, notifyUsers, setupNotifications };