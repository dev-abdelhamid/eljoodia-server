// routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const authMiddleware = require('../middleware/auth'); // استيراد middleware التوثيق

// Middleware للتوثيق
const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, message: 'التوثيق مطلوب' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    req.user = {
      id: user._id,
      username: user.username,
      role: user.role,
      branchId: user.branch ? user.branch.toString() : null,
      permissions: user.permissions || [],
    };
    console.log('Auth middleware - req.user:', req.user);
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ success: false, message: 'التوكن غير صالح أو منتهي الصلاحية' });
  }
};

// Middleware للتصريح
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
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
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    const user = await User.findOne({ username }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const refreshToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

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
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

// جلب ملف المستخدم
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }
    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        branchId: user.branch ? user.branch.toString() : null,
        permissions: user.permissions || [],
      },
    });
  } catch (error) {
    console.error('Get profile error:', error);
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

    const user = await User.findByIdAndUpdate(req.user.id, updateData, { new: true }).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        branchId: user.branch ? user.branch.toString() : null,
      },
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

// التحقق من البريد الإلكتروني
router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'البريد الإلكتروني مطلوب' });
    }
    const user = await User.findOne({ email }).lean();
    res.status(200).json({ success: true, exists: !!user });
  } catch (error) {
    console.error('Check email error:', error);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

// تجديد التوكن
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'التوكن المنعش مطلوب' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const newToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.status(200).json({ success: true, token: newToken });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({ success: false, message: 'التوكن المنعش غير صالح أو منتهي الصلاحية' });
  }
});

module.exports = router;