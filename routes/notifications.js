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

router.post(
  '/',
  [
    auth,
    authorize(['admin', 'branch', 'production', 'chef']),
    notificationLimiter,
    check('type').isIn([
      'orderCreated',
      'taskAssigned',
      'taskStarted',
      'taskCompleted',
      'orderStatusUpdated',
      'orderDelivered',
      'returnStatusUpdated',
      'missingAssignments',
    ]).withMessage('نوع الإشعار غير صالح'),
    check('message').notEmpty().withMessage('الرسالة مطلوبة'),
    check('data').optional().isObject().withMessage('البيانات يجب أن تكون كائنًا'),
    check('data.orderId').optional().isMongoId().withMessage('معرف الطلب غير صالح'),
    check('data.taskId').optional().isMongoId().withMessage('معرف المهمة غير صالح'),
    check('data.returnId').optional().isMongoId().withMessage('معرف الإرجاع غير صالح'),
    check('data.branchId').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    check('data.chefId').optional().isMongoId().withMessage('معرف الشيف غير صالح'),
    check('data.departmentId').optional().isMongoId().withMessage('معرف القسم غير صالح'),
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
      const io = req.app.get('io');

      // التحقق من الشيف إذا تم توفير chefId
      if (data.chefId) {
        const chefProfile = await mongoose.model('Chef').findOne({ user: data.chefId }).lean();
        if (!chefProfile) {
          console.error(`[${new Date().toISOString()}] Invalid chefId: ${data.chefId}`);
          return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
        }
      }

      // إنشاء eventId فريد
      const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${Date.now()}`;
      const notificationData = {
        ...data,
        eventId,
        timestamp: new Date().toISOString(),
        sound: data.sound || '/sounds/notification.mp3',
        vibrate: data.vibrate || [200, 100, 200],
      };

      // تحديد الغرف لإرسال الإشعار
      const rooms = new Set(['admin', 'production']);
      if (data.chefId) rooms.add(`chef-${data.chefId}`);
      if (data.departmentId) rooms.add(`department-${data.departmentId}`);
      if (data.branchId) rooms.add(`branch-${data.branchId}`);
      if (userId) rooms.add(`user-${userId}`);

      // إنشاء الإشعار
      const notification = await createNotification(
        userId,
        type,
        message,
        notificationData,
        io,
        [...rooms]
      );

      // إرسال الإشعار عبر Socket.IO
      rooms.forEach(room => {
        io.to(room).emit(type, notification);
        console.log(`[${new Date().toISOString()}] Emitted ${type} to room ${room}:`, notification);
      });

      res.status(201).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in POST /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get('/', [auth, notificationLimiter], async (req, res) => {
  try {
    const { page = 1, limit = 50, read, chefId, departmentId, branchId } = req.query;
    const query = { user: req.user.id };

    if (read !== undefined) query.read = read === 'true';
    if (chefId && mongoose.isValidObjectId(chefId)) query['data.chefId'] = chefId;
    if (departmentId && mongoose.isValidObjectId(departmentId)) query['data.departmentId'] = departmentId;
    if (branchId && mongoose.isValidObjectId(branchId)) query['data.branchId'] = branchId;

    console.log(`[${new Date().toISOString()}] Fetching notifications for user ${req.user.id}:`, { page, limit, read, chefId, departmentId, branchId });

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
    console.log(`[${new Date().toISOString()}] Marked notification ${notification._id} as read for user ${req.user.id}`);

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