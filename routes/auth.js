const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { auth } = require('../middleware/auth'); // Add this import

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

const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role },
    process.env.JWT_ACCESS_SECRET || 'your_access_secret',
    {
      expiresIn: process.env.JWT_ACCESS_EXPIRE || '15m',
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
      const user = await User.findOne({ username: { $regex: `^${username}$`, $options: 'i' } }).select('+password');

      if (!user) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const token = generateToken(user);
      user.lastLogin = new Date();
      await user.save();

      const userData = {
        id: user._id.toString(),
        username: user.username,
        role: user.role,
        name: user.name,
        branchId: user.branch ? user.branch.toString() : undefined,
        chefDepartment: user.department ? user.department.toString() : undefined,
        permissions: getPermissions(user.role),
      };

      res.json({ success: true, token, user: userData });
    } catch (error) {
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
    }
  }
);

// Get profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: user.name,
      branchId: user.branch ? user.branch.toString() : undefined,
      chefDepartment: user.department ? user.department.toString() : undefined,
      permissions: getPermissions(user.role),
    };

    res.json({ success: true, user: userData });
  } catch (error) {
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
  }
});

module.exports = router;