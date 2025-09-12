const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { check, validationResult } = require('express-validator');
const { createNotification } = require('../utils/notifications');
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
    authorize(['admin', 'branch', 'production', 'chef']),
    notificationLimiter,
    check('type').isIn([
      'orderCreated',
      'itemCompleted',
      'orderConfirmed',
      'taskAssigned',
      'itemStatusUpdated',
      'orderStatusUpdated',
      'orderCompleted',
      'orderShipped',
      'orderDelivered',
      'returnStatusUpdated',
      'missingAssignments',
      'orderApproved',
      'orderInTransit',
      'branchConfirmedReceipt',
      'taskStarted',
      'taskCompleted',
    ]).withMessage('نوع الإشعار غير صالح'),
    check('messageKey').notEmpty().withMessage('مفتاح الرسالة مطلوب'),
    check('params').optional().isObject().withMessage('البارامز يجب أن تكون كائنًا'),
    check('data').optional().isObject().withMessage('البيانات يجب أن تكون كائنًا'),
    check('userId').isMongoId().withMessage('معرف المستخدم غير صالح'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Validation errors in POST /notifications:`, errors.array());
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { userId, type, messageKey, params = {}, data = {} } = req.body;
      console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, messageKey, params, data });

      const notification = await createNotification(userId, type, messageKey, params, { ...data, eventId: `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${userId}` }, req.app.get('io'), true);
      res.status(201).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in POST /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get('/', [auth, notificationLimiter], async (req, res) => {
  try {
    const { page = 1, limit = 100, userId, branchId, chefId, departmentId } = req.query;
    const query = {};

    if (userId) query.user = userId;
    if (branchId) query['data.branchId'] = branchId;
    if (chefId) query['data.chefId'] = chefId;
    if (departmentId) query['data.departmentId'] = departmentId;

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('user', 'username role branch')
      .lean();

    const total = await Notification.countDocuments(query);

    res.json({
      success: true,
      data: notifications.map(n => ({
        _id: n._id,
        type: n.type,
        messageKey: n.messageKey,
        params: n.params,
        message: n.message,
        data: n.data,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in GET /notifications:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/user/:userId', [auth, notificationLimiter], async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 100 } = req.query;

    if (!mongoose.isValidObjectId(userId)) {
      console.error(`[${new Date().toISOString()}] Invalid user ID: ${userId}`);
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    const notifications = await Notification.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('user', 'username role branch')
      .lean();

    const total = await Notification.countDocuments({ user: userId });

    res.json({
      success: true,
      data: notifications.map(n => ({
        _id: n._id,
        type: n.type,
        messageKey: n.messageKey,
        params: n.params,
        message: n.message,
        data: n.data,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in GET /notifications/user/:userId:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.put('/:id/read', [auth, notificationLimiter], async (req, res) => {
  try {
    const { id } = req.params;
    if (!id.match(/^[0-9a-fA-F]{24}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
      return res.status(400).json({ success: false, message: 'معرف الإشعار غير صالح' });
    }

    const notification = await Notification.findByIdAndUpdate(id, { read: true }, { new: true }).lean();
    if (!notification) {
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }

    req.app.get('io').to(`user-${notification.user}`).emit('notificationRead', { notificationId: id });
    res.json({ success: true, data: notification });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PUT /notifications/:id/read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.put('/mark-all-read', [auth, notificationLimiter], async (req, res) => {
  try {
    const { userId } = req.body;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    await Notification.updateMany({ user: userId, read: false }, { read: true });
    req.app.get('io').to(`user-${userId}`).emit('allNotificationsRead', { userId });
    res.json({ success: true, message: 'تم وضع علامة مقروء على جميع الإشعارات' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in PUT /notifications/mark-all-read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.delete('/clear', [auth, notificationLimiter], async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user.id });
    req.app.get('io').to(`user-${req.user.id}`).emit('notificationsCleared', { userId: req.user.id });
    res.json({ success: true, message: 'تم مسح جميع الإشعارات' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in DELETE /notifications/clear:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;