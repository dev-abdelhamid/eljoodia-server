const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
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
      const isRtl = req.query.isRtl === 'true';
      const user = await User.findOne({ username: { $regex: `^${username}$`, $options: 'i' } })
        .select('+password')
        .populate('branch', 'name nameEn code address city phone')
        .populate('department', 'name nameEn code description');

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
        name: isRtl ? user.name : user.nameEn || user.name,
        nameEn: user.nameEn,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        branch: user.branch
          ? {
              id: user.branch._id.toString(),
              name: isRtl ? user.branch.name : user.branch.nameEn || user.branch.name,
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
        permissions: getPermissions(user.role),
      };

      res.json({ success: true, token: accessToken, refreshToken, user: userData });
    } catch (error) {
      console.error(`خطأ في تسجيل الدخول في ${new Date().toISOString()}:`, error);
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
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
      .populate('branch', 'name nameEn code address city phone')
      .populate('department', 'name nameEn code description')
      .lean();

    if (!user) {
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const isRtl = req.query.isRtl === 'true';
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: isRtl ? user.name : user.nameEn || user.name,
      nameEn: user.nameEn,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      branch: user.branch
        ? {
            id: user.branch._id.toString(),
            name: isRtl ? user.branch.name : user.branch.nameEn || user.branch.name,
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
      permissions: getPermissions(user.role),
    };

    res.status(200).json({ success: true, token: newAccessToken, refreshToken: newRefreshToken, user: userData });
  } catch (err) {
    console.error(`خطأ في تجديد التوكن في ${new Date().toISOString()}:`, err);
    res.status(401).json({ success: false, message: 'الـ Refresh Token غير صالح أو منتهي الصلاحية' });
  }
});

// Get profile
router.get('/profile', auth, async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('branch', 'name nameEn code address city phone')
      .populate('department', 'name nameEn code description');

    if (!user) {
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: isRtl ? user.name : user.nameEn || user.name,
      nameEn: user.nameEn,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      branch: user.branch
        ? {
            id: user.branch._id.toString(),
            name: isRtl ? user.branch.name : user.branch.nameEn || user.branch.name,
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
      permissions: getPermissions(user.role),
    };

    res.json({ success: true, user: userData });
  } catch (error) {
    console.error(`خطأ في جلب الملف الشخصي في ${new Date().toISOString()}:`, error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
  }
});

// Update profile
router.put(
  '/update-profile',
  [
    auth,
    check('name', 'الاسم مطلوب').optional().notEmpty(),
    check('nameEn', 'الاسم الإنجليزي مطلوب').optional().notEmpty(),
    check('email', 'الإيميل غير صالح').optional().isEmail(),
    check('phone', 'رقم الهاتف غير صالح').optional().matches(/^\+?\d{10,15}$/),
    check('password', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل').optional().isLength({ min: 6 }),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { name, nameEn, email, phone, password } = req.body;
      const isRtl = req.query.isRtl === 'true';

      if (!getPermissions(req.user.role).includes('manage_users') && req.user.id !== req.user.id) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ success: false, message: 'غير مصرح لك بتعديل البيانات' });
      }

      const user = await User.findById(req.user.id).session(session);
      if (!user) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      }

      if (email && email !== user.email) {
        const existingEmail = await User.findOne({ email: email.trim().toLowerCase(), _id: { $ne: user._id } }).session(session);
        if (existingEmail) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ success: false, message: 'الإيميل مستخدم بالفعل' });
        }
      }

      if (name) user.name = name.trim();
      if (nameEn) user.nameEn = nameEn.trim();
      if (email) user.email = email.trim().toLowerCase();
      if (phone) user.phone = phone.trim();
      if (password) user.password = await bcrypt.hash(password, 10);

      await user.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedUser = await User.findById(user._id)
        .select('-password')
        .populate('branch', 'name nameEn code address city phone')
        .populate('department', 'name nameEn code description');

      const userData = {
        id: populatedUser._id.toString(),
        username: populatedUser.username,
        role: populatedUser.role,
        name: isRtl ? populatedUser.name : populatedUser.nameEn || populatedUser.name,
        nameEn: populatedUser.nameEn,
        email: populatedUser.email,
        phone: populatedUser.phone,
        isActive: populatedUser.isActive,
        lastLogin: populatedUser.lastLogin,
        createdAt: populatedUser.createdAt,
        updatedAt: populatedUser.updatedAt,
        branch: populatedUser.branch
          ? {
              id: populatedUser.branch._id.toString(),
              name: isRtl ? populatedUser.branch.name : populatedUser.branch.nameEn || populatedUser.branch.name,
              code: populatedUser.branch.code,
              address: populatedUser.branch.address,
              city: populatedUser.branch.city,
              phone: populatedUser.branch.phone,
            }
          : null,
        department: populatedUser.department
          ? {
              id: populatedUser.department._id.toString(),
              name: isRtl ? populatedUser.department.name : populatedUser.department.nameEn || populatedUser.department.name,
              code: populatedUser.department.code,
              description: populatedUser.department.description,
            }
          : null,
        permissions: getPermissions(populatedUser.role),
      };

      res.json({ success: true, user: userData });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      console.error(`خطأ في تحديث الملف الشخصي في ${new Date().toISOString()}:`, error);
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
    }
  }
);

module.exports = router;