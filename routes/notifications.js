const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { check, validationResult } = require('express-validator');
const { createNotification } = require('../utils/notifications');

const notificationLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'طلبات الإشعارات كثيرة جدًا، حاول مرة أخرى لاحقًا',
});

// Cache for users
const usersCache = new Map();

const getUsers = async (roles, branchId = null) => {
  const cacheKey = `${roles.join('-')}-${branchId || 'all'}`;
  if (usersCache.has(cacheKey)) return usersCache.get(cacheKey);
  const query = { role: { $in: roles } };
  if (branchId) query.branch = branchId;
  const users = await User.find(query).select('_id username branch').lean();
  usersCache.set(cacheKey, users);
  return users;
};

router.post(
  '/',
  [
    auth,
    authorize(['admin', 'branch', 'production', 'chef']),
    notificationLimiter,
    check('user').isMongoId().withMessage('معرف المستخدم غير صالح'),
    check('type').isIn([
      'new_order',
      'order_approved',
      'task_assigned',
      'task_completed',
      'order_status_updated',
      'order_in_transit',
      'order_delivered',
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

      const { user, type, message, data = {} } = req.body;
      const requesterId = req.user.id;

      // Authorization check
      if (req.user.role !== 'admin' && req.user.id !== user) {
        console.error(`[${new Date().toISOString()}] Unauthorized notification creation:`, { requesterId, targetUser: user });
        return res.status(403).json({ success: false, message: 'غير مخول لإنشاء إشعار لهذا المستخدم' });
      }

      // Check if user exists
      const targetUser = await User.findById(user).select('role branch').lean();
      if (!targetUser) {
        console.error(`[${new Date().toISOString()}] Target user not found:`, { user });
        return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      }

      // Restrict branch users to their own branch
      if (req.user.role === 'branch' && data.branchId && data.branchId !== req.user.branchId.toString()) {
        console.error(`[${new Date().toISOString()}] Branch user attempted to notify another branch:`, { requesterId, branchId: data.branchId });
        return res.status(403).json({ success: false, message: 'غير مخول لإرسال إشعار لهذا الفرع' });
      }

      const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${user}-${Date.now()}`;
      const notification = await createNotification(user, type, message, { ...data, eventId }, req.app.get('io'));

      console.log(`[${new Date().toISOString()}] Created notification for user ${user}:`, { type, message, data });

      res.status(201).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in POST /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get('/', [auth, notificationLimiter], async (req, res) => {
  try {
    const { page = 1, limit = 50, read, branchId } = req.query;
    const query = { user: req.user.id };

    if (read !== undefined) query.read = read === 'true';
    if (req.user.role === 'branch' && !branchId) query.branch = req.user.branchId;
    if (branchId) query['data.branchId'] = branchId;

    console.log(`[${new Date().toISOString()}] Fetching notifications for user ${req.user.id}:`, { page, limit, read, branchId });

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
    console.log(`[${new Date().toISOString()}] Marked notification ${req.params.id} as read for user ${req.user.id}`);

    res.json({ success: true, data: notification });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PATCH /notifications/:id/read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.patch('/mark-all-read', [auth, notificationLimiter], async (req, res) => {
  try {
    const { user } = req.body;
    if (!user || user !== req.user.id) {
      console.error(`[${new Date().toISOString()}] Unauthorized attempt to mark all notifications:`, { user, requester: req.user.id });
      return res.status(403).json({ success: false, message: 'غير مخول لتعليم إشعارات مستخدم آخر' });
    }

    await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
    req.app.get('io').to(`user-${req.user.id}`).emit('allNotificationsRead', { userId: req.user.id });
    console.log(`[${new Date().toISOString()}] Marked all notifications as read for user ${req.user.id}`);

    res.json({ success: true, message: 'تم تعليم جميع الإشعارات كمقروءة' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PATCH /notifications/mark-all-read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.delete('/:id', [auth, notificationLimiter], async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({ _id: req.params.id, user: req.user.id });

    if (!notification) {
      console.error(`[${new Date().toISOString()}] Notification not found or unauthorized:`, { id: req.params.id, user: req.user.id });
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }

    req.app.get('io').to(`user-${req.user.id}`).emit('notificationDeleted', { id: notification._id });
    console.log(`[${new Date().toISOString()}] Deleted notification ${notification._id} for user ${req.user.id}`);

    res.json({ success: true, message: 'تم حذف الإشعار' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in DELETE /notifications/:id:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;