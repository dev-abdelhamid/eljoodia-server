const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const mongoose = require('mongoose');

router.get('/', async (req, res) => {
  try {
    const { userId, read, page = 1, limit = 50, departmentId, branchId, chefId } = req.query;
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }
    const query = { user: userId };
    if (read !== undefined) query.read = read === 'true';
    if (departmentId) query['data.departmentId'] = departmentId;
    if (branchId) query['data.branchId'] = branchId;
    if (chefId) query['data.chefId'] = chefId;
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();
    res.status(200).json(notifications);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching notifications:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { user, type, message, data } = req.body;
    if (!user || !type || !message) {
      return res.status(400).json({ success: false, message: 'البيانات المطلوبة مفقودة' });
    }
    const notification = await Notification.create({
      user: user.map(id => mongoose.Types.ObjectId(id)),
      type,
      message,
      data,
      read: false,
      createdAt: new Date(),
    });
    res.status(201).json(notification);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الإشعار غير صالح' });
    }
    await Notification.updateOne({ _id: id }, { $set: { read: true } });
    res.status(200).json({ success: true, message: 'تم تعليم الإشعار كمقروء' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error marking notification as read:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.put('/mark-all-read/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }
    await Notification.updateMany({ user: userId, read: false }, { $set: { read: true } });
    res.status(200).json({ success: true, message: 'تم تعليم جميع الإشعارات كمقروءة' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error marking all notifications as read:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.delete('/clear', async (req, res) => {
  try {
    await Notification.deleteMany({});
    res.status(200).json({ success: true, message: 'تم مسح جميع الإشعارات' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error clearing notifications:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;