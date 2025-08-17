// routes/auth.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
require('dotenv').config();

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
    { id: user._id, username: user.username, role: user.role, branchId: user.branch ? user.branch.toString() : undefined, departmentId: user.department ? user.department.toString() : undefined },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRE || '15m' }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d' }
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
        console.error(`Validation errors in login at ${new Date().toISOString()}:`, errors.array());
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { username, password } = req.body;
      const user = await User.findOne({ username: { $regex: `^${username}$`, $options: 'i' } })
        .select('+password')
        .populate('branch', 'name')
        .populate('department', 'name');
      if (!user) {
        console.error(`User not found during login at ${new Date().toISOString()}:`, username);
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        console.error(`Invalid password for user at ${new Date().toISOString()}:`, username);
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const token = generateToken(user);
      const refreshToken = generateRefreshToken(user);
      user.lastLogin = new Date();
      await user.save();

      const userData = {
        id: user._id.toString(),
        username: user.username,
        role: user.role,
        name: user.name,
        branchId: user.branch ? user.branch.toString() : undefined,
        branchName: user.branch?.name,
        chefDepartment: user.department ? user.department.toString() : undefined,
        departmentName: user.department?.name,
        permissions: getPermissions(user.role),
      };

      console.log(`Login successful for user at ${new Date().toISOString()}:`, userData);
      res.json({ success: true, token, refreshToken, user: userData });
    } catch (error) {
      console.error(`Login error at ${new Date().toISOString()}:`, error);
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم', error: error.message });
    }
  }
);

// Get profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('branch', 'name')
      .populate('department', 'name');
    if (!user) {
      console.error(`User not found for profile request at ${new Date().toISOString()}:`, req.user.id);
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: user.name,
      branchId: user.branch ? user.branch.toString() : undefined,
      branchName: user.branch?.name,
      chefDepartment: user.department ? user.department.toString() : undefined,
      departmentName: user.department?.name,
      permissions: getPermissions(user.role),
    };

    console.log(`Profile fetched for user at ${new Date().toISOString()}:`, userData);
    res.json({ success: true, user: userData });
  } catch (error) {
    console.error(`Get profile error at ${new Date().toISOString()}:`, error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم', error: error.message });
    }
});

// Refresh token endpoint
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      console.error(`No refresh token provided at ${new Date().toISOString()}`);
      return res.status(401).json({ success: false, message: 'التوكن المنعش مطلوب' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const user = await User.findById(decoded.id)
      .populate('branch', 'name')
      .populate('department', 'name');
    if (!user) {
      console.error(`User not found for refresh token at ${new Date().toISOString()}:`, decoded.id);
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const newToken = generateToken(user);
    console.log(`Token refreshed for user at ${new Date().toISOString()}:`, { id: user._id, username: user.username });
    res.json({ success: true, token: newToken });
  } catch (error) {
    console.error(`Refresh token error at ${new Date().toISOString()}:`, error);
    res.status(401).json({ success: false, message: 'التوكن المنعش غير صالح أو منتهي الصلاحية', error: error.message });
  }
});

module.exports = router;