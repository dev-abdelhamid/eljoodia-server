const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const Notification = require('../models/Notification');

const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 100, // 100 طلب لكل IP
});

router.get('/', [auth, notificationLimiter], async (req, res) => {
  try {
    const { page = 1, limit = 50, read } = req.query;
    const query = { user: req.user.id };
    if (read !== undefined) query.read = read === 'true';

    const [notifications, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('user', 'username role branch')
        .lean(),
      Notification.countDocuments(query),
    ]);

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    const formatted = notifications.map(n => ({
      ...n,
      data: {
        ...n.data,
        eventId: n.data.eventId,
      },
      sound: `${baseUrl}/sounds/notification.mp3`,
      soundType: 'notification',
      vibrate: [200, 100, 200],
      timestamp: n.createdAt.toISOString(),
    }));

    res.json({ success: true, data: formatted, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in GET /notifications:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/mark-as-read/:id', [auth, notificationLimiter], async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    }
    res.json({ success: true, data: notification });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in POST /notifications/mark-as-read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/mark-all-as-read', [auth, notificationLimiter], async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
    res.json({ success: true, message: 'تم تعليم جميع الإشعارات كمقروءة' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in POST /notifications/mark-all-as-read:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.delete('/clear', [auth, notificationLimiter], async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user.id });
    res.json({ success: true, message: 'تم حذف جميع الإشعارات' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in DELETE /notifications/clear:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;