const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { check, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'طلبات الإشعارات كثيرة جدًا، حاول مرة أخرى لاحقًا'
});

// Create a notification
router.post(
  '/',
  [
    auth,
    authorize('admin', 'branch', 'production', 'chef'),
    notificationLimiter,
    check('user').isMongoId().withMessage('معرف المستخدم غير صالح'),
    check('type')
      .isIn([
        'order_created',
        'order_approved',
        'order_status_updated',
        'task_assigned',
        'task_completed',
        'order_completed',
        'order_in_transit',
        'order_delivered',
        'return_created',
        'return_status_updated',
        'missing_assignments'
      ])
      .withMessage('نوع الإشعار غير صالح'),
    check('message').notEmpty().withMessage('الرسالة مطلوبة'),
    check('branch').optional().isMongoId().withMessage('معرف الفرع غير صالح')
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { user, type, message, data, branch } = req.body;

      const targetUser = await User.findById(user).select('username role branchId').lean();
      if (!targetUser) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] User not found: ${user}`);
        return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      }

      if (branch) {
        const branchDoc = await Branch.findById(branch).select('name').lean();
        if (!branchDoc) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Branch not found: ${branch}`);
          return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
        }
      }

      const notification = new Notification({
        user,
        branch: branch || targetUser.branchId || null,
        type,
        message: message.trim(),
        data: data || {},
        read: false,
        sound: '/notification.mp3',
        vibrate: [200, 100, 200]
      });
      await notification.save({ session });

      const populatedNotification = await Notification.findById(notification._id)
        .populate('user', 'username role branchId')
        .populate('branch', 'name')
        .lean();

      const eventData = {
        _id: notification._id,
        type: notification.type,
        message: notification.message,
        data: notification.data,
        read: notification.read,
        sound: notification.sound,
        vibrate: notification.vibrate,
        user: populatedNotification.user ? {
          _id: populatedNotification.user._id,
          username: populatedNotification.user.username,
          role: populatedNotification.user.role,
          branchId: populatedNotification.user.branchId
        } : null,
        branch: populatedNotification.branch ? {
          _id: populatedNotification.branch._id,
          name: populatedNotification.branch.name
        } : null,
        createdAt: notification.createdAt
      };

      const io = req.app.get('io');
      const rooms = [`user-${user}`];
      if (targetUser.role === 'admin') rooms.push('admin');
      if (targetUser.role === 'production') rooms.push('production');
      if (targetUser.role === 'branch' && targetUser.branchId) rooms.push(`branch-${targetUser.branchId}`);
      if (targetUser.role === 'chef' && targetUser.branchId) rooms.push(`branch-${targetUser.branchId}`);
      if (branch) rooms.push(`branch-${branch}`);

      rooms.forEach(room => {
        io.of('/api').to(room).emit('newNotification', eventData);
        console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, {
          type: eventData.type,
          user: eventData.user?._id,
          branch: eventData.branch?._id
        });
      });

      await session.commitTransaction();
      res.status(201).json({ success: true, data: populatedNotification });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Get notifications
router.get(
  '/',
  [auth, notificationLimiter],
  async (req, res) => {
    try {
      const { user, read, branch, page = 1, limit = 20 } = req.query;
      const query = {};

      // Validate user ID if provided
      if (user && !mongoose.isValidObjectId(user)) {
        console.error(`[${new Date().toISOString()}] Invalid user ID: ${user}`);
        return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
      }

      // Validate branch ID if provided
      if (branch && !mongoose.isValidObjectId(branch)) {
        console.error(`[${new Date().toISOString()}] Invalid branch ID: ${branch}`);
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }

      // Build query based on user role
      if (user && req.user.role === 'admin') {
        query.user = user;
      } else if (req.user.role === 'production' || req.user.role === 'admin') {
        if (branch) query.branch = branch;
      } else if (req.user.role === 'branch' && req.user.branchId) {
        query.branch = req.user.branchId;
        query.user = req.user.id;
      } else {
        query.user = req.user.id;
      }

      // Filter by read status if provided
      if (read !== undefined) {
        query.read = read === 'true';
      }

      console.log(`[${new Date().toISOString()}] Fetching notifications with query:`, query);

      const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('user', 'username role branchId')
        .populate('branch', 'name')
        .lean();

      const total = await Notification.countDocuments(query);

      const formattedNotifications = notifications.map(notification => ({
        _id: notification._id,
        type: notification.type,
        message: notification.message,
        data: notification.data || {},
        read: notification.read,
        sound: notification.sound,
        vibrate: notification.vibrate,
        user: notification.user ? {
          _id: notification.user._id,
          username: notification.user.username,
          role: notification.user.role,
          branchId: notification.user.branchId
        } : null,
        branch: notification.branch ? {
          _id: notification.branch._id,
          name: notification.branch.name
        } : null,
        createdAt: notification.createdAt
      }));

      res.status(200).json({
        success: true,
        data: formattedNotifications,
        total,
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching notifications:`, {
        message: err.message,
        stack: err.stack,
        query: req.query,
        user: req.user
      });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// Get a single notification
router.get(
  '/:id',
  [auth, check('id').isMongoId().withMessage('معرف الإشعار غير صالح')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'معرف الإشعار غير صالح' });
      }

      const notification = await Notification.findById(req.params.id)
        .populate('user', 'username role branchId')
        .populate('branch', 'name')
        .lean();

      if (!notification) {
        console.error(`[${new Date().toISOString()}] Notification not found: ${req.params.id}`);
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      if (notification.user?._id.toString() !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'production') {
        console.error(`[${new Date().toISOString()}] Unauthorized access to notification: ${req.params.id}, user: ${req.user.id}`);
        return res.status(403).json({ success: false, message: 'غير مخول لعرض هذا الإشعار' });
      }

      const formattedNotification = {
        _id: notification._id,
        type: notification.type,
        message: notification.message,
        data: notification.data || {},
        read: notification.read,
        sound: notification.sound,
        vibrate: notification.vibrate,
        user: notification.user ? {
          _id: notification.user._id,
          username: notification.user.username,
          role: notification.user.role,
          branchId: notification.user.branchId
        } : null,
        branch: notification.branch ? {
          _id: notification.branch._id,
          name: notification.branch.name
        } : null,
        createdAt: notification.createdAt
      };

      res.status(200).json({ success: true, data: formattedNotification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching notification:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// Mark notification as read
router.patch(
  '/:id/read',
  [auth, check('id').isMongoId().withMessage('معرف الإشعار غير صالح')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, errors: errors.array(), message: 'معرف الإشعار غير صالح' });
      }

      const notification = await Notification.findById(req.params.id).session(session);
      if (!notification) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Notification not found: ${req.params.id}`);
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      if (notification.user.toString() !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'production') {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Unauthorized to mark notification: ${req.params.id}, user: ${req.user.id}`);
        return res.status(403).json({ success: false, message: 'غير مخول لتعديل هذا الإشعار' });
      }

      notification.read = true;
      await notification.save({ session });

      const populatedNotification = await Notification.findById(notification._id)
        .populate('user', 'username role branchId')
        .populate('branch', 'name')
        .lean();

      const io = req.app.get('io');
      const eventData = {
        id: notification._id,
        read: true,
        user: populatedNotification.user ? {
          _id: populatedNotification.user._id,
          username: populatedNotification.user.username,
          role: populatedNotification.user.role,
          branchId: populatedNotification.user.branchId
        } : null,
        branch: populatedNotification.branch ? {
          _id: populatedNotification.branch._id,
          name: populatedNotification.branch.name
        } : null
      };
      io.of('/api').to(`user-${notification.user}`).emit('notificationUpdated', eventData);

      await session.commitTransaction();
      res.status(200).json({ success: true, data: populatedNotification });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error marking notification as read:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Delete notification
router.delete(
  '/:id',
  [auth, check('id').isMongoId().withMessage('معرف الإشعار غير صالح')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, errors: errors.array(), message: 'معرف الإشعار غير صالح' });
      }

      const notification = await Notification.findById(req.params.id).session(session);
      if (!notification) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Notification not found: ${req.params.id}`);
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      if (notification.user.toString() !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'production') {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Unauthorized to delete notification: ${req.params.id}, user: ${req.user.id}`);
        return res.status(403).json({ success: false, message: 'غير مخول لحذف هذا الإشعار' });
      }

      await notification.deleteOne({ session });
      const io = req.app.get('io');
      io.of('/api').to(`user-${notification.user}`).emit('notificationDeleted', { id: notification._id });

      await session.commitTransaction();
      res.status(200).json({ success: true, message: 'تم حذف الإشعار' });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error deleting notification:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Mark all notifications as read
router.patch(
  '/mark-all-read',
  [auth, check('user').optional().isMongoId().withMessage('معرف المستخدم غير صالح')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { user, branch } = req.body;
      const query = { read: false };

      if (user && (req.user.role === 'admin' || req.user.role === 'production')) {
        query.user = user;
      } else if (req.user.role === 'branch' && req.user.branchId) {
        query.branch = req.user.branchId;
        query.user = req.user.id;
      } else {
        query.user = req.user.id;
      }

      if (branch && (req.user.role === 'admin' || req.user.role === 'production')) {
        if (!mongoose.isValidObjectId(branch)) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid branch ID: ${branch}`);
          return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
        }
        query.branch = branch;
      }

      const updateResult = await Notification.updateMany(query, { read: true }, { session });
      console.log(`[${new Date().toISOString()}] Marked ${updateResult.modifiedCount} notifications as read for user: ${query.user}`);

      const io = req.app.get('io');
      io.of('/api').to(`user-${query.user}`).emit('allNotificationsRead', { user: query.user, branch: query.branch });

      await session.commitTransaction();
      res.status(200).json({ success: true, message: 'تم تحديد كل الإشعارات كمقروءة', modifiedCount: updateResult.modifiedCount });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error marking all notifications as read:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;