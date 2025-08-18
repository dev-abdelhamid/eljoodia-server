const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { check, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

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
      .isIn(['order_created', 'order_status_updated', 'return_created', 'return_status_updated', 'order_delivered', 'task_assigned', 'task_status_updated', 'order_completed'])
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
      const notification = new Notification({
        user,
        type,
        message: message.trim(),
        data: data || {},
        read: false,
        createdAt: new Date(),
      });
      await notification.save();

      const io = req.app.get('io');
      io.to(`user-${user}`).emit('newNotification', notification);
      console.log(`تم إنشاء إشعار وإرساله في ${new Date().toISOString()}:`, { user, type, message });

      res.status(201).json(notification);
    } catch (err) {
      console.error(`خطأ في إنشاء الإشعار في ${new Date().toISOString()}:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get(
  '/',
  [auth, notificationLimiter],
  async (req, res) => {
    try {
      const { user, read, page = 1, limit = 10 } = req.query;
      const query = {};
      if (user && req.user.role === 'admin') query.user = user;
      else query.user = req.user.id;
      if (read !== undefined) query.read = read === 'true';

      const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean();

      res.json(notifications);
    } catch (err) {
      console.error(`خطأ في جلب الإشعارات في ${new Date().toISOString()}:`, err);
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

      const notification = await Notification.findById(req.params.id).lean();
      if (!notification) {
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      if (notification.user.toString() !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'غير مخول لعرض هذا الإشعار' });
      }

      res.json(notification);
    } catch (err) {
      console.error(`خطأ في جلب الإشعار في ${new Date().toISOString()}:`, err);
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

      if (notification.user.toString() !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'غير مخول لتعديل هذا الإشعار' });
      }

      notification.read = true;
      await notification.save();

      res.json(notification);
    } catch (err) {
      console.error(`خطأ في تحديد الإشعار كمقروء في ${new Date().toISOString()}:`, err);
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

      if (notification.user.toString() !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'غير مخول لحذف هذا الإشعار' });
      }

      await notification.deleteOne();
      res.json({ success: true, message: 'تم حذف الإشعار' });
    } catch (err) {
      console.error(`خطأ في حذف الإشعار في ${new Date().toISOString()}:`, err);
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
      if (user && req.user.role === 'admin') query.user = user;
      else query.user = req.user.id;

      await Notification.updateMany(query, { read: true });
      res.json({ success: true, message: 'تم تحديد كل الإشعارات كمقروءة' });
    } catch (err) {
      console.error(`خطأ في تحديد كل الإشعارات كمقروءة في ${new Date().toISOString()}:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

module.exports = router;