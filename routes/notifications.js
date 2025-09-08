const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { check, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

router.post(
  '/',
  [
    auth,
    authorize(['admin', 'branch', 'production', 'chef']),
    check('type').isIn([
      'new_order_from_branch',
      'branch_confirmed_receipt',
      'new_order_for_production',
      'order_completed_by_chefs',
      'order_approved_for_branch',
      'order_in_transit_to_branch',
      'new_production_assigned_to_chef',
      'order_status_updated',
      'task_assigned',
      'task_completed',
      'order_completed',
      'order_delivered',
      'return_status_updated',
      'missing_assignments',
      'order_created',
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
      const eventId = data.eventId || uuidv4();
      console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data, eventId });
      
      const notification = new Notification({
        user: userId,
        type,
        message,
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
      
      req.app.get('io').to(`user-${userId}`).emit(type, { ...data, eventId, _id: notification._id });
      console.log(`[${new Date().toISOString()}] Notification emitted:`, { type, eventId, userId });
      
      res.status(201).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in POST /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.get('/', [auth], async (req, res) => {
  try {
    const { page = 1, limit = 50, read } = req.query;
    const query = { user: req.user.id };
    if (read !== undefined) query.read = read === 'true';
    console.log(`[${new Date().toISOString()}] Fetching notifications for user ${req.user.id}:`, { page, limit, read });
    
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

router.patch('/:id/read', [auth], async (req, res) => {
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

router.patch('/mark-all-read', [auth], async (req, res) => {
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

router.delete('/:id', [auth], async (req, res) => {
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