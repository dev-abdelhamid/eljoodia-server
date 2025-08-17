// routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
require('dotenv').config();

// Middleware للتوثيق
const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    console.error(`No token provided in request at ${new Date().toISOString()}`);
    return res.status(401).json({ success: false, message: 'التوثيق مطلوب' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      console.error(`User not found for token at ${new Date().toISOString()}:`, decoded.id);
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    req.user = {
      id: user._id,
      username: user.username,
      role: user.role,
      branchId: user.branch ? user.branch.toString() : null,
      permissions: user.permissions || [],
    };
    console.log(`Auth middleware - req.user at ${new Date().toISOString()}:`, req.user);
    next();
  } catch (error) {
    console.error(`Auth middleware error at ${new Date().toISOString()}:`, error.message);
    res.status(401).json({ success: false, message: 'التوكن غير صالح أو منتهي الصلاحية', error: error.message });
  }
};

// Middleware للتصريح
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      console.error(`Unauthorized access attempt at ${new Date().toISOString()}:`, { user: req.user, roles });
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }
    next();
  };
};

// تسجيل الدخول
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      console.error(`Missing credentials in login request at ${new Date().toISOString()}:`, { username });
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    const user = await User.findOne({ username }).select('+password');
    if (!user) {
      console.error(`User not found during login at ${new Date().toISOString()}:`, username);
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.error(`Invalid password for user at ${new Date().toISOString()}:`, username);
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
    }

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, branchId: user.branch ? user.branch.toString() : null },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const refreshToken = jwt.sign(
      { id: user._id, username: user.username, role: user.role, branchId: user.branch ? user.branch.toString() : null },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`Login successful for user at ${new Date().toISOString()}:`, { id: user._id, username, role: user.role });
    res.status(200).json({
      success: true,
      token,
      refreshToken,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        branchId: user.branch ? user.branch.toString() : null,
      },
    });
  } catch (error) {
    console.error(`Login error at ${new Date().toISOString()}:`, error);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

// جلب ملف المستخدم
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('branch', 'name')
      .lean();
    if (!user) {
      console.error(`User not found for profile request at ${new Date().toISOString()}:`, req.user.id);
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }
    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        branchId: user.branch ? user.branch.toString() : null,
        branchName: user.branch?.name || null,
        permissions: user.permissions || [],
      },
    });
  } catch (error) {
    console.error(`Get profile error at ${new Date().toISOString()}:`, error);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

// تحديث ملف المستخدم
router.put('/profile', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    const updateData = {};
    if (name) updateData.name = name.trim();
    if (password) updateData.password = await bcrypt.hash(password, 10);

    const user = await User.findByIdAndUpdate(req.user.id, updateData, { new: true })
      .populate('branch', 'name')
      .lean();
    if (!user) {
      console.error(`User not found for profile update at ${new Date().toISOString()}:`, req.user.id);
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        branchId: user.branch ? user.branch.toString() : null,
        branchName: user.branch?.name || null,
      },
    });
  } catch (error) {
    console.error(`Update profile error at ${new Date().toISOString()}:`, error);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

// التحقق من البريد الإلكتروني
router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      console.error(`Missing email in check-email request at ${new Date().toISOString()}`);
      return res.status(400).json({ success: false, message: 'البريد الإلكتروني مطلوب' });
    }
    const user = await User.findOne({ email }).lean();
    res.status(200).json({ success: true, exists: !!user });
  } catch (error) {
    console.error(`Check email error at ${new Date().toISOString()}:`, error);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

// تجديد التوكن
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      console.error(`No refresh token provided at ${new Date().toISOString()}`);
      return res.status(401).json({ success: false, message: 'التوكن المنعش مطلوب' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      console.error(`User not found for refresh token at ${new Date().toISOString()}:`, decoded.id);
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const newToken = jwt.sign(
      { id: user._id, username: user.username, role: user.role, branchId: user.branch ? user.branch.toString() : null },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    console.log(`Token refreshed for user at ${new Date().toISOString()}:`, { id: user._id, username: user.username });
    res.status(200).json({ success: true, token: newToken });
  } catch (error) {
    console.error(`Refresh token error at ${new Date().toISOString()}:`, error);
    res.status(401).json({ success: false, message: 'التوكن المنعش غير صالح أو منتهي الصلاحية', error: error.message });
  }
});

module.exports = router;