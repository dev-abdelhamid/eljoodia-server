const express = require('express');
const Notification = require('../models/Notification');

const router = express.Router();

const ownsNotification = async (req, res, next) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) return res.status(404).json({ success: false, message: 'الإشعار غير موجود' });
    if (notification.user.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'غير مخول لهذا الإشعار' });
    req.notification = notification;
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في التحقق من ملكية الإشعار:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

router.get('/', async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json(notifications);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع الإشعارات:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

router.patch('/:id/read', ownsNotification, async (req, res) => {
  try {
    req.notification.read = true;
    await req.notification.save();
    res.status(200).json(req.notification);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في تحديد الإشعار كمقروء:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

router.delete('/:id', ownsNotification, async (req, res) => {
  try {
    await req.notification.deleteOne();
    res.status(200).json({ success: true, message: 'تم حذف الإشعار' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في حذف الإشعار:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

router.patch('/read-all', async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
    res.status(200).json({ success: true, message: 'تم تحديد كل الإشعارات كمقروءة' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في تحديد كل الإشعارات كمقروءة:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

module.exports = router;