const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Chef = require('../models/Chef');
const Branch = require('../models/Branch');
const Department = require('../models/department');
const { auth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const refreshTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 10,
  message: 'طلبات تجديد التوكن كثيرة جدًا، حاول مرة أخرى لاحقًا.',
});

const getPermissions = (role) => {
  switch (role) {
    case 'admin':
      return ['manage_users', 'manage_branches', 'manage_products', 'view_reports', 'manage_orders'];
    case 'production':
      return ['manage_orders', 'view_reports'];
    case 'branch':
      return ['create_orders', 'view_branch_orders', 'manage_inventory'];
    case 'chef':
      return ['update_order_items', 'view_assigned_orders'];
    default:
      return [];
  }
};

const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role, branchId: user.branch, departmentId: user.department },
    process.env.JWT_ACCESS_SECRET || 'your_access_secret',
    {
      expiresIn: process.env.JWT_ACCESS_EXPIRE || '15m',
      issuer: process.env.JWT_ISSUER || 'your_jwt_issuer',
      audience: process.env.JWT_AUDIENCE || 'your_jwt_audience',
    }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role },
    process.env.JWT_REFRESH_SECRET || 'your_refresh_secret',
    {
      expiresIn: '7d',
      issuer: process.env.JWT_ISSUER || 'your_jwt_issuer',
      audience: process.env.JWT_AUDIENCE || 'your_jwt_audience',
    }
  );
};

// Login endpoint
router.post(
  '/login',
  [
    check('username', 'اسم المستخدم مطلوب').not().isEmpty(),
    check('password', 'كلمة المرور مطلوبة').not().isEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { username, password } = req.body;
      const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
      const user = await User.findOne({ username: { $regex: `^${username}$`, $options: 'i' } })
        .select('+password')
        .populate('branch', 'name nameEn code')
        .populate('department', 'name nameEn code');

      if (!user) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);
      user.lastLogin = new Date();
      await user.save();

      const userData = {
        id: user._id.toString(),
        username: user.username,
        role: user.role,
        name: isRtl ? user.name : user.displayName,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive,
        branch: user.branch
          ? {
              id: user.branch._id.toString(),
              name: isRtl ? user.branch.name : user.branch.displayName,
              code: user.branch.code,
            }
          : null,
        department: user.department
          ? {
              id: user.department._id.toString(),
              name: isRtl ? user.department.name : user.department.nameEn || user.department.name,
              code: user.department.code,
            }
          : null,
        permissions: getPermissions(user.role),
      };

      res.json({ success: true, token: accessToken, refreshToken, user: userData });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] خطأ في تسجيل الدخول:`, error.message, error.stack);
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم', error: error.message });
    }
  }
);

// Refresh Token endpoint
router.post('/refresh-token', refreshTokenLimiter, async (req, res) => {
  const refreshToken = req.body.refreshToken || req.header('Authorization')?.replace('Bearer ', '');
  if (!refreshToken) {
    return res.status(401).json({ success: false, message: 'الـ Refresh Token مطلوب' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || 'your_refresh_secret');
    const user = await User.findById(decoded.id)
      .populate('branch', 'name nameEn code')
      .populate('department', 'name nameEn code')
      .lean();
    if (!user) {
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: isRtl ? user.name : user.nameEn || user.name,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      branch: user.branch
        ? {
            id: user.branch._id.toString(),
            name: isRtl ? user.branch.name : user.branch.nameEn || user.branch.name,
            code: user.branch.code,
          }
        : null,
      department: user.department
        ? {
            id: user.department._id.toString(),
            name: isRtl ? user.department.name : user.department.nameEn || user.department.name,
            code: user.department.code,
          }
        : null,
      permissions: getPermissions(user.role),
    };

    res.status(200).json({ success: true, token: newAccessToken, refreshToken: newRefreshToken, user: userData });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في تجديد التوكن:`, err.message, err.stack);
    res.status(401).json({ success: false, message: 'الـ Refresh Token غير صالح أو منتهي الصلاحية' });
  }
});

// Get profile endpoint
router.get('/profile', auth, async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('branch', 'name nameEn code address city phone')
      .populate('department', 'name nameEn code description');

    if (!user) {
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    let chefProfile = null;
    if (user.role === 'chef') {
      chefProfile = await Chef.findOne({ user: user._id })
        .populate('department', 'name nameEn code description')
        .lean();
    }

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: isRtl ? user.name : user.displayName,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      lastLogin: user.lastLogin,
      branch: user.branch
        ? {
            id: user.branch._id.toString(),
            name: isRtl ? user.branch.name : user.branch.displayName,
            code: user.branch.code,
            address: user.branch.address,
            city: user.branch.city,
            phone: user.branch.phone,
          }
        : null,
      department: user.department
        ? {
            id: user.department._id.toString(),
            name: isRtl ? user.department.name : user.department.nameEn || user.department.name,
            code: user.department.code,
            description: user.department.description,
          }
        : null,
      chefProfile: chefProfile
        ? {
            id: chefProfile._id.toString(),
            status: chefProfile.status,
            department: chefProfile.department
              ? {
                  id: chefProfile.department._id.toString(),
                  name: isRtl ? chefProfile.department.name : chefProfile.department.nameEn || chefProfile.department.name,
                  code: chefProfile.department.code,
                  description: chefProfile.department.description,
                }
              : null,
          }
        : null,
      permissions: getPermissions(user.role),
    };

    res.json({ success: true, user: userData });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب الملف الشخصي:`, error.message, error.stack);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم', error: error.message });
  }
});

module.exports = router;