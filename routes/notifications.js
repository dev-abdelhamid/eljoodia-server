const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { check, validationResult } = require('express-validator');
const { createNotification } = require('../utils/notifications');

const notificationLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'طلبات الإشعارات كثيرة جدًا، حاول مرة أخرى لاحقًا',
});

// إنشاء إشعار
router.post(
  '/',
  [
    auth,
    authorize(['admin', 'branch', 'production', 'chef']),
    notificationLimiter,
    check('user').isMongoId().withMessage('معرف المستخدم غير صالح'),
    check('type').isIn([
      'new_order_from_branch',
      'branch_confirmed_receipt',
      'new_order_for_production',
      'order_completed_by_chefs',
      'order_approved_for_branch',
      'order_in_transit_to_branch',
      'new_production_assigned_to_chef',
    ]).withMessage('نوع الإشعار غير صالح'),
    check('message').notEmpty().withMessage('الرسالة مطلوبة'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { user, type, message, data } = req.body;
      const notification = await createNotification(user, type, message, data, req.app.get('io'));
      res.status(201).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in POST /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
  }
);

// جلب الإشعارات
router.get('/', [auth, notificationLimiter], async (req, res) => {
  try {
    const { page = 1, limit = 20, read } = req.query;
    const query = { user: req.user.id };
    if (read !== undefined) query.read = read === 'true';

    const [notifications, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('user', 'username role branch department')
        .lean(),
      Notification.countDocuments(query),
    ]);

    res.json({ success: true, data: notifications, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in GET /notifications:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// تحديث حالة القراءة
router.patch('/:id/read', [auth, notificationLimiter], async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }
    req.app.get('io').of('/api').to(`user-${req.user.id}`).emit('notificationUpdated', { id: notification._id, read: true });
    res.json({ success: true, data: notification });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PATCH /notifications/:id/read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// حذف إشعار
router.delete('/:id', [auth, notificationLimiter], async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({ _id: req.params.id, user: req.user.id });
    if (!notification) {
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }
    req.app.get('io').of('/api').to(`user-${req.user.id}`).emit('notificationDeleted', { id: notification._id });
    res.json({ success: true, message: 'تم حذف الإشعار' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in DELETE /notifications/:id:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

module.exports = router;