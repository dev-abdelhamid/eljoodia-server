const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const bcrypt = require('bcryptjs');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    const user = await User.findOne({ username }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'بيانات الاعتماد غير صالحة' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, branchId: user.branch, departmentId: user.department },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    user.lastLogin = new Date();
    await user.save();

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        name: user.name,
        email: user.email,
        phone: user.phone,
        branchId: user.branch,
        departmentId: user.department,
      },
    });
  } catch (err) {
    console.error(`خطأ في تسجيل الدخول في ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/refresh', async (req, res) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, message: 'التوكن مطلوب' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const newToken = jwt.sign(
      { id: user._id, role: user.role, branchId: user.branch, departmentId: user.department },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.status(200).json({ success: true, token: newToken });
  } catch (err) {
    console.error(`خطأ في تجديد التوكن في ${new Date().toISOString()}:`, err);
    res.status(401).json({ success: false, message: 'التوكن غير صالح' });
  }
});

module.exports = router;