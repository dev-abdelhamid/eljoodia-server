const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { check, validationResult } = require('express-validator');
const { createNotification } = require('../utils/notifications');
const mongoose = require('mongoose');

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
    check('type')
      .isIn([
        'orderCreated',
        'taskAssigned',
        'taskStatusUpdated',
        'taskCompleted',
        'orderStatusUpdated',
        'orderCompleted',
        'orderDelivered',
        'returnStatusUpdated',
        'missingAssignments',
      ])
      .withMessage('نوع الإشعار غير صالح'),
    check('message').notEmpty().withMessage('الرسالة مطلوبة'),
    check('data').optional().isObject().withMessage('البيانات يجب أن تكون كائنًا'),
    check('data.orderId').optional().isMongoId().withMessage('معرف الطلب غير صالح'),
    check('data.taskId').optional().isMongoId().withMessage('معرف المهمة غير صالح'),
    check('data.returnId').optional().isMongoId().withMessage('معرف الإرجاع غير صالح'),
    check('data.branchId').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    check('data.chefId').optional().isMongoId().withMessage('معرف الشيف غير صالح'),
    check('data.departmentId').optional().isMongoId().withMessage('معرف القسم غير صالح'),
    check('data.eventId').optional().notEmpty().withMessage('معرف الحدث مطلوب'),
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

      if (data.eventId) {
        const existingNotification = await Notification.findOne({ 'data.eventId': data.eventId });
        if (existingNotification) {
          console.log(`[${new Date().toISOString()}] Duplicate notification ignored:`, data.eventId);
          return res.status(200).json({ success: true, message: 'الإشعار موجود بالفعل', data: existingNotification });
        }
      }

      if (data.chefId) {
        const chefProfile = await mongoose.model('Chef').findOne({ user: data.chefId }).lean();
        if (!chefProfile) {
          console.error(`[${new Date().toISOString()}] Invalid chefId: ${data.chefId}`);
          return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
        }
      }

      const eventId = data.eventId || `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${Date.now()}`;
      const notificationData = {
        ...data,
        eventId,
        timestamp: new Date().toISOString(),
        sound: data.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: data.vibrate || [200, 100, 200],
      };

      const rooms = new Set(['admin', 'production']);
      if (data.chefId) rooms.add(`chef-${data.chefId}`);
      if (data.departmentId) rooms.add(`department-${data.departmentId}`);
      if (data.branchId) rooms.add(`branch-${data.branchId}`);
      if (userId) rooms.add(`user-${userId}`);

      const notification = await createNotification(
        userId,
        type,
        message,
        notificationData,
        io,
        [...rooms]
      );

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

router.get(
  '/',
  [auth, authorize(['admin', 'branch', 'production', 'chef'])],
  async (req, res) => {
    try {
      const { userId, read, page = 1, limit = 50, departmentId, branchId, chefId, eventId } = req.query;
      const query = {};

      if (userId && mongoose.isValidObjectId(userId)) query.user = userId;
      if (read !== undefined) query.read = read === 'true';
      if (departmentId && mongoose.isValidObjectId(departmentId)) query['data.departmentId'] = departmentId;
      if (branchId && mongoose.isValidObjectId(branchId)) query['data.branchId'] = branchId;
      if (chefId && mongoose.isValidObjectId(chefId)) query['data.chefId'] = chefId;
      if (eventId) query['data.eventId'] = eventId;

      const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean();

      res.status(200).json({ success: true, data: notifications });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in GET /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.patch(
  '/:id/read',
  [auth, authorize(['admin', 'branch', 'production', 'chef'])],
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        console.error(`[${new Date().toISOString()}] Invalid notification ID: ${id}`);
        return res.status(400).json({ success: false, message: 'معرف الإشعار غير صالح' });
      }

      const notification = await Notification.findById(id);
      if (!notification) {
        console.error(`[${new Date().toISOString()}] Notification not found: ${id}`);
        return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
      }

      notification.read = true;
      await notification.save();

      res.status(200).json({ success: true, data: notification });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in PATCH /notifications/:id/read:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.delete(
  '/',
  [auth, authorize(['admin', 'branch', 'production', 'chef'])],
  async (req, res) => {
    try {
      await Notification.deleteMany({ user: req.user.id });
      res.status(200).json({ success: true, message: 'تم حذف جميع الإشعارات' });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in DELETE /notifications:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

module.exports = router;