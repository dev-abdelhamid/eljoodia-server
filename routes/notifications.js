const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { check, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const mongoose = require('mongoose');

const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'طلبات الإشعارات كثيرة جدًا، حاول مرة أخرى لاحقًا',
});

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
        'return_created',
        'return_status_updated',
        'task_assigned',
        'task_status_updated',
        'task_completed',
        'order_completed',
        'order_in_transit',
        'order_delivered',
        'missing_assignments',
      ])
      .withMessage('نوع الإشعار غير صالح'),
    check('message').notEmpty().withMessage('الرسالة مطلوبة'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { user, type, message, data } = req.body;
      const targetUser = await User.findById(user).lean();
      if (!targetUser) {
        return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      }

      const notification = new Notification({
        user,
        type,
        message: message.trim(),
        data: data || {},
        read: false,
        sound: 'https://eljoodia.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        createdAt: new Date(),
        department: targetUser.department || null,
      });
      await notification.save();

      const populatedNotification = await Notification.findById(notification._id)
        .populate('user', 'username role branch department')
        .populate('department', 'name')
        .lean();

      const eventData = {
        _id: notification._id,
        type: notification.type,
        message: notification.message,
        data: notification.data,
        read: notification.read,
        sound: notification.sound,
        vibrate: notification.vibrate,
        user: populatedNotification.user,
        department: populatedNotification.department,
        createdAt: notification.createdAt,
      };

      const io = req.app.get('io');
      const rooms = [`user-${user}`];
      if (targetUser.role === 'admin') rooms.push('admin');
      if (targetUser.role === 'production') rooms.push('production');
      if (targetUser.role === 'branch' && targetUser.branch) rooms.push(`branch-${targetUser.branch}`);
      if (targetUser.role === 'chef' && targetUser.department) rooms.push(`department-${targetUser.department}`);

      rooms.forEach(room => {
        io.of('/api').to(room).emit('newNotification', eventData);
        console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
      });

      res.status(201).json({ success: true, data: populatedNotification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error creating notification:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get(
  '/',
  [auth, notificationLimiter],
  async (req, res) => {
    try {
      const { user, read, page = 1, limit = 20, department } = req.query;
      const query = {};

      if (user && !mongoose.isValidObjectId(user)) {
        return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
      }

      if (user && req.user.role === 'admin') {
        query.user = user;
      } else if (req.user.role === 'production' || req.user.role === 'admin') {
        if (department && mongoose.isValidObjectId(department)) {
          query.department = department;
        } else if (department) {
          return res.status(400).json({ success: false, message: 'معرف القسم غير صالح' });
        }
      } else {
        query.user = req.user.id;
      }

      if (read !== undefined) {
        query.read = read === 'true';
      }

      console.log(`[${new Date().toISOString()}] Fetching notifications with query:`, query);

      const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate({
          path: 'user',
          select: 'username role branch department',
          populate: [
            { path: 'branch', select: 'name' },
            { path: 'department', select: 'name' },
          ],
        })
        .lean();

      const total = await Notification.countDocuments(query);

      const formattedNotifications = notifications.map(notification => ({
        _id: notification._id,
        type: notification.type,
        message: notification.message,
        data: notification.data || {},
        read: notification.read,
        sound: 'https://eljoodia.vercel.app/sounds/notification.mp3',
        vibrate: notification.vibrate || [200, 100, 200],
        user: notification.user ? {
          _id: notification.user._id,
          username: notification.user.username,
          role: notification.user.role,
          branch: notification.user.branch,
          department: notification.user.department,
        } : null,
        department: notification.department,
        createdAt: notification.createdAt,
      }));

      res.status(200).json({
        success: true,
        data: formattedNotifications,
        total,
        page: parseInt(page),
        limit: parseInt(limit),
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Detailed error fetching notifications:`, {
        message: err.message,
        stack: err.stack,
        query: req.query,
        user: req.user,
      });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

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
        .populate({
          path: 'user',
          select: 'username role branch department',
          populate: [
            { path: 'branch', select: 'name' },
            { path: 'department', select: 'name' },
          ],
        })
        .lean();
      if (!notification) {
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      if (notification.user?._id.toString() !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'production') {
        return res.status(403).json({ success: false, message: 'غير مخول لعرض هذا الإشعار' });
      }

      const formattedNotification = {
        _id: notification._id,
        type: notification.type,
        message: notification.message,
        data: notification.data || {},
        read: notification.read,
        sound: 'https://eljoodia.vercel.app/sounds/notification.mp3',
        vibrate: notification.vibrate || [200, 100, 200],
        user: notification.user ? {
          _id: notification.user._id,
          username: notification.user.username,
          role: notification.user.role,
          branch: notification.user.branch,
          department: notification.user.department,
        } : null,
        department: notification.department,
        createdAt: notification.createdAt,
      };

      res.status(200).json({ success: true, data: formattedNotification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching notification:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.patch(
  '/:id/read',
  [auth, check('id').isMongoId().withMessage('معرف الإشعار غير صالح')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'معرف الإشعار غير صالح' });
      }

      const notification = await Notification.findById(req.params.id);
      if (!notification) {
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      if (notification.user.toString() !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'production') {
        return res.status(403).json({ success: false, message: 'غير مخول لتعديل هذا الإشعار' });
      }

      notification.read = true;
      await notification.save();

      const io = req.app.get('io');
      io.of('/api').to(`user-${notification.user}`).emit('notificationUpdated', { id: notification._id, read: true });
      res.status(200).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error marking notification as read:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.delete(
  '/:id',
  [auth, check('id').isMongoId().withMessage('معرف الإشعار غير صالح')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'معرف الإشعار غير صالح' });
      }

      const notification = await Notification.findById(req.params.id);
      if (!notification) {
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      if (notification.user.toString() !== req.user.id && req.user.role !== 'adminഗ

System: admin' && req.user.role !== 'production') {
        return res.status(403).json({ success: false, message: 'غير مخول لحذف هذا الإشعار' });
      }

      await notification.deleteOne();
      const io = req.app.get('io');
      io.of('/api').to(`user-${notification.user}`).emit('notificationDeleted', { id: notification._id });
      res.status(200).json({ success: true, message: 'تم حذف الإشعار' });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error deleting notification:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.patch(
  '/mark-all-read',
  [auth, check('user').optional().isMongoId().withMessage('معرف المستخدم غير صالح')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { user } = req.body;
      const query = { read: false };
      if (user && (req.user.role === 'admin' || req.user.role === 'production')) {
        query.user = user;
      } else {
        query.user = req.user.id;
      }

      await Notification.updateMany(query, { read: true });
      const io = req.app.get('io');
      io.of('/api').to(`user-${query.user}`).emit('allNotificationsRead', { user: query.user });
      res.status(200).json({ success: true, message: 'تم تحديد كل الإشعارات كمقروءة' });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error marking all notifications as read:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

module.exports = router;