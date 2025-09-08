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

router.post(
  '/',
  [
    auth,
    authorize(['admin', 'branch', 'production', 'chef']),
    notificationLimiter,
    check('type').isIn([
      'new_order_from_branch',
      'order_approved_for_branch',
      'task_assigned',
      'task_completed',
      'order_completed_by_chefs',
      'order_in_transit_to_branch',
      'branch_confirmed_receipt',
      'order_status_updated',
      'return_status_updated',
      'missing_assignments',
    ]).withMessage('نوع الإشعار غير صالح'),
    check('message').notEmpty().withMessage('الرسالة مطلوبة'),
    check('data').optional().isObject().withMessage('البيانات يجب أن تكون كائنًا'),
    check('data.orderId').optional().isMongoId().withMessage('معرف الطلب غير صالح'),
    check('data.taskId').optional().isMongoId().withMessage('معرف المهمة غير صالح'),
    check('data.returnId').optional().isMongoId().withMessage('معرف الإرجاع غير صالح'),
    check('data.branchId').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    check('data.chefId').optional().isMongoId().withMessage('معرف الشيف غير صالح'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Validation errors in POST /notifications:`, errors.array());
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { type, message, data = {} } = req.body;
      const userId = req.user.id;

      console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data });

      const notification = await createNotification(userId, type, message, { ...data, eventId: data.eventId || require('uuid').v4() }, req.app.get('io'));

      res.status(201).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in POST /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get('/', [auth, notificationLimiter], async (req, res) => {
  try {
    const { page = 1, limit = 50, read, departmentId, branchId, chefId } = req.query;
    const query = { user: req.user.id };
    if (read !== undefined) query.read = read === 'true';
    if (departmentId) query['data.departmentId'] = departmentId;
    if (branchId) query['data.branchId'] = branchId;
    if (chefId) query['data.chefId'] = chefId;

    console.log(`[${new Date().toISOString()}] Fetching notifications for user ${req.user.id}:`, { page, limit, read, departmentId, branchId, chefId });

    const [notifications, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('user', 'username role branch')
        .lean(),
      Notification.countDocuments(query),
    ]);

    res.json({ success: true, data: notifications, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in GET /notifications:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.patch('/:id/read', [auth, notificationLimiter], async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );

    if (!notification) {
      console.error(`[${new Date().toISOString()}] Notification not found or unauthorized:`, { id: req.params.id, user: req.user.id });
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }

    req.app.get('io').to(`user-${req.user.id}`).emit('notificationUpdated', { id: notification._id, read: true });
    res.json({ success: true, data: notification });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PATCH /notifications/:id/read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.patch('/mark-all-read', [auth, notificationLimiter], async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
    req.app.get('io').to(`user-${req.user.id}`).emit('allNotificationsRead', { userId: req.user.id });
    console.log(`[${new Date().toISOString()}] Marked all notifications as read for user ${req.user.id}`);
    res.json({ success: true, message: 'تم تعليم جميع الإشعارات كمقروءة' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PATCH /notifications/mark-all-read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.delete('/clear', [auth, notificationLimiter], async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user.id });
    req.app.get('io').to(`user-${req.user.id}`).emit('notificationsCleared', { userId: req.user.id });
    console.log(`[${new Date().toISOString()}] Cleared notifications for user ${req.user.id}`);
    res.json({ success: true, message: 'تم حذف جميع الإشعارات' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in DELETE /notifications/clear:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;