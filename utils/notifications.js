const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { v4: uuidv4 } = require('uuid');

class NotificationService {
  static validTypes = [
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
    'task_completed',
    'missing_assignments',
  ];

  static soundTypeMap = {
    new_order_from_branch: 'new_order',
    order_approved_for_branch: 'order_approved',
    new_production_assigned_to_chef: 'task_assigned',
    order_completed_by_chefs: 'task_completed',
    order_in_transit_to_branch: 'order_in_transit',
    order_delivered: 'order_delivered',
    branch_confirmed_receipt: 'order_delivered',
    return_status_updated: 'return_updated',
    order_status_updated: 'order_status_updated',
    task_assigned: 'task_assigned',
    task_completed: 'task_completed',
    missing_assignments: 'missing_assignments',
  };

  static async createNotification(userId, type, message, data = {}, io) {
    try {
      if (!mongoose.isValidObjectId(userId)) {
        throw new Error('معرف المستخدم غير صالح');
      }
      if (!this.validTypes.includes(type)) {
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
      const soundType = this.soundTypeMap[type] || 'default';
      const notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: message.trim(),
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
        message: notification.message,
        data: {
          ...notification.data,
          branchId: data.branchId || targetUser.branch?._id?.toString(),
          taskId: data.taskId,
          orderId: data.orderId,
          chefId: data.chefId,
          returnId: data.returnId,
        },
        read: notification.read,
        user: {
          _id: populatedNotification.user._id,
          username: populatedNotification.user.username,
          role: populatedNotification.user.role,
          branch: populatedNotification.user.branch || null,
        },
        createdAt: new Date(notification.createdAt).toISOString(),
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
  }

  static async deleteOldNotifications() {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await Notification.deleteMany({ createdAt: { $lt: thirtyDaysAgo } });
      console.log(`[${new Date().toISOString()}] Deleted notifications older than 30 days`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error deleting old notifications:`, err);
    }
  }

  static async getNotifications(userId, limit = 100) {
    try {
      if (!mongoose.isValidObjectId(userId)) {
        throw new Error('معرف المستخدم غير صالح');
      }
      const notifications = await Notification.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('user', 'username role')
        .lean();
      return notifications.map(n => ({
        ...n,
        createdAt: new Date(n.createdAt).toISOString(),
      }));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching notifications:`, err);
      throw err;
    }
  }


  static setupNotifications = (io, socket) => {
  socket.on('orderCreated', async (data) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { orderId, orderNumber, branchId } = data;
      const order = await mongoose.model('Order').findById(orderId).populate('branch', 'name').session(session).lean();
      if (!order) return;

      const message = `طلب جديد ${orderNumber} من ${order.branch?.name || 'Unknown'}`;
      const eventData = {
        orderId,
        branchId,
        eventId: `${orderId}-new_order_from_branch`,
      };

      const users = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id').lean();

      for (const user of users) {
        await NotificationService.createNotification(user._id, 'new_order_from_branch', message, eventData, io);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling orderCreated:`, err);
    } finally {
      session.endSession();
    }
  });

    socket.on('orderApproved', async (data) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, orderNumber, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId)
          .populate('branch', 'name')
          .session(session)
          .lean();
        if (!order) {
          throw new Error('الطلب غير موجود');
        }

        const message = `تم اعتماد الطلب ${orderNumber} لـ ${order.branch?.name || 'Unknown'}`;
        const eventData = {
          orderId,
          orderNumber,
          branchId,
          eventId: `${orderId}-order_approved_for_branch`,
        };

        const users = await User.find({
          $or: [
            { role: { $in: ['admin', 'production'] } },
            { role: 'branch', branch: branchId },
          ],
        }).select('_id').lean();

        for (const user of users) {
          await this.createNotification(user._id, 'order_approved_for_branch', message, eventData, io);
        }

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Error handling orderApproved:`, err);
      } finally {
        session.endSession();
      }
    });

    socket.on('taskAssigned', async (data) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, taskId, chefId, productId, productName, quantity, branchId, itemId } = data;
        const order = await mongoose.model('Order').findById(orderId)
          .populate('branch', 'name')
          .session(session)
          .lean();
        if (!order) {
          throw new Error('الطلب غير موجود');
        }

        const message = `تم تعيين مهمة جديدة لك في الطلب ${order.orderNumber || 'Unknown'}`;
        const eventData = {
          orderId,
          taskId,
          branchId: order.branch?._id || branchId,
          chefId,
          productId,
          productName,
          quantity,
          itemId,
          eventId: `${itemId}-new_production_assigned_to_chef`,
        };

        const users = await User.find({
          $or: [
            { role: { $in: ['admin', 'production'] } },
            { _id: chefId, role: 'chef' },
            { role: 'branch', branch: order.branch?._id || branchId },
          ],
        }).select('_id').lean();

        for (const user of users) {
          await this.createNotification(user._id, 'new_production_assigned_to_chef', message, eventData, io);
        }

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Error handling taskAssigned:`, err);
      } finally {
        session.endSession();
      }
    });

    socket.on('taskCompleted', async (data) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, taskId, chefId, productName, itemId } = data;
        const order = await mongoose.model('Order').findById(orderId)
          .populate('branch', 'name')
          .session(session);
        if (!order) {
          throw new Error('الطلب غير موجود');
        }

        const message = `تم إكمال مهمة (${productName || 'Unknown'}) في الطلب ${order.orderNumber || 'Unknown'}`;
        const eventData = {
          orderId,
          taskId,
          branchId: order.branch?._id,
          chefId,
          productName,
          itemId,
          eventId: `${taskId}-task_completed`,
        };

        const users = await User.find({
          $or: [
            { role: { $in: ['admin', 'production'] } },
            { role: 'branch', branch: order.branch?._id },
            { _id: chefId, role: 'chef' },
          ],
        }).select('_id').lean();

        for (const user of users) {
          await this.createNotification(user._id, 'task_completed', message, eventData, io);
        }

        const allTasks = await mongoose.model('ProductionAssignment').find({ order: orderId }).session(session).lean();
        const isOrderCompleted = allTasks.every(task => task.status === 'completed');

        if (isOrderCompleted) {
          order.status = 'completed';
          order.statusHistory.push({
            status: 'completed',
            changedBy: chefId,
            changedAt: new Date(),
          });
          await order.save({ session });

          const completionMessage = `تم إكمال الطلب ${order.orderNumber} بالكامل`;
          const completionEventData = {
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            eventId: `${orderId}-order_completed_by_chefs`,
          };

          for (const user of users) {
            await this.createNotification(user._id, 'order_completed_by_chefs', completionMessage, completionEventData, io);
          }

          await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`], 'orderStatusUpdated', {
            orderId,
            status: 'completed',
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            branchName: order.branch?.name || 'Unknown',
            eventId: `${orderId}-order_completed_by_chefs`,
          });
        }

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Error handling taskCompleted:`, err);
      } finally {
        session.endSession();
      }
    });

    socket.on('orderInTransit', async (data) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, orderNumber, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId)
          .populate('branch', 'name')
          .session(session)
          .lean();
        if (!order) {
          throw new Error('الطلب غير موجود');
        }

        const message = `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'Unknown'}`;
        const eventData = {
          orderId,
          orderNumber,
          branchId,
          eventId: `${orderId}-order_in_transit_to_branch`,
        };

        const users = await User.find({
          $or: [
            { role: { $in: ['admin', 'production'] } },
            { role: 'branch', branch: branchId },
          ],
        }).select('_id').lean();

        for (const user of users) {
          await this.createNotification(user._id, 'order_in_transit_to_branch', message, eventData, io);
        }

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Error handling orderInTransit:`, err);
      } finally {
        session.endSession();
      }
    });

    socket.on('branchConfirmed', async (data) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const { orderId, orderNumber, branchId } = data;
        const order = await mongoose.model('Order').findById(orderId)
          .populate('branch', 'name')
          .session(session)
          .lean();
        if (!order) {
          throw new Error('الطلب غير موجود');
        }

        const message = `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'Unknown'}`;
        const eventData = {
          orderId,
          orderNumber,
          branchId,
          eventId: `${orderId}-branch_confirmed_receipt`,
        };

        const users = await User.find({
          $or: [
            { role: { $in: ['admin', 'production'] } },
            { role: 'branch', branch: branchId },
          ],
        }).select('_id').lean();

        for (const user of users) {
          await this.createNotification(user._id, 'branch_confirmed_receipt', message, eventData, io);
        }

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Error handling branchConfirmed:`, err);
      } finally {
        session.endSession();
      }
    });
  }
}

module.exports = { NotificationService, setupNotifications };