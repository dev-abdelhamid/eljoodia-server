const express = require('express');
const { body } = require('express-validator');
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const User = require('../models/User');
const Branch = require('../models/Branch');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const users = await User.find()
      .populate('branch', 'name nameEn');
    const transformedUsers = users.map(user => ({
      ...user.toObject(),
      name: user.displayName,
      branch: user.branch ? {
        ...user.branch,
        name: user.branch.displayName
      } : null
    }));
    res.status(200).json(transformedUsers);
  } catch (err) {
    console.error('Get users error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }
    const user = await User.findById(req.params.id)
      .populate('branch', 'name nameEn');
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    const transformedUser = {
      ...user.toObject(),
      name: user.displayName,
      branch: user.branch ? {
        ...user.branch,
        name: user.branch.displayName
      } : null
    };
    res.status(200).json(transformedUser);
  } catch (err) {
    console.error('Get user error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/', [
  auth,
  authorize('admin'),
  body('name').notEmpty().withMessage('الاسم مطلوب'),
  body('username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
  body('role').isIn(['admin', 'branch', 'chef', 'production']).withMessage('الدور غير صالح'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, nameEn, username, email, phone, role, branch, isActive, password } = req.body;

    if (role === 'branch' && !branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'الفرع مطلوب للمستخدمين من نوع branch' });
    }

    const existingUser = await User.findOne({ username: username.trim() }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${username}' مستخدم بالفعل` });
    }

    if (email) {
      const existingEmail = await User.findOne({ email: email.trim().toLowerCase() }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${email}' مستخدم بالفعل` });
      }
    }

    if (role === 'branch') {
      const existingBranchUser = await User.findOne({ branch, role: 'branch' }).session(session);
      if (existingBranchUser) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الفرع '${branch}' مرتبط بمستخدم آخر` });
      }
    }

    const newUser = new User({
      name: name.trim(),
      nameEn: nameEn ? nameEn.trim() : undefined,
      username: username.trim(),
      password,
      role,
      email: email ? email.trim().toLowerCase() : undefined,
      phone: phone ? phone.trim() : undefined,
      branch: role === 'branch' ? branch : undefined,
      isActive: isActive ?? true,
    });
    await newUser.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedUser = await User.findById(newUser._id)
      .populate('branch', 'name nameEn');
    res.status(201).json({
      ...populatedUser.toObject(),
      name: populatedUser.displayName,
      branch: populatedUser.branch ? {
        ...populatedUser.branch,
        name: populatedUser.branch.displayName
      } : null
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Create user error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field });
    }
    res.status(400).json({ message: 'خطأ في إنشاء المستخدم', error: err.message });
  }
});

router.put('/:id', [
  auth,
  authorize('admin'),
  body('name').notEmpty().withMessage('الاسم مطلوب'),
  body('username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('role').isIn(['admin', 'branch', 'chef', 'production']).withMessage('الدور غير صالح'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, nameEn, username, email, phone, role, branch, isActive } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }

    const user = await User.findById(req.params.id).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    if (user.role === 'admin' && req.user.id !== req.params.id) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'لا يمكن تعديل حسابات الإدارة' });
    }

    const existingUser = await User.findOne({ username: username.trim(), _id: { $ne: req.params.id } }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${username}' مستخدم بالفعل` });
    }

    if (email) {
      const existingEmail = await User.findOne({ email: email.trim().toLowerCase(), _id: { $ne: req.params.id } }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${email}' مستخدم بالفعل` });
      }
    }

    if (role === 'branch') {
      if (!branch) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'الفرع مطلوب للمستخدمين من نوع branch' });
      }
      const existingBranchUser = await User.findOne({ branch, role: 'branch', _id: { $ne: req.params.id } }).session(session);
      if (existingBranchUser) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الفرع '${branch}' مرتبط بمستخدم آخر` });
      }
    }

    user.name = name.trim();
    user.nameEn = nameEn ? nameEn.trim() : undefined;
    user.username = username.trim();
    user.email = email ? email.trim().toLowerCase() : undefined;
    user.phone = phone ? phone.trim() : undefined;
    user.role = role;
    user.branch = role === 'branch' ? branch : undefined;
    user.isActive = isActive ?? user.isActive;
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedUser = await User.findById(user._id)
      .populate('branch', 'name nameEn');
    res.status(200).json({
      ...populatedUser.toObject(),
      name: populatedUser.displayName,
      branch: populatedUser.branch ? {
        ...populatedUser.branch,
        name: populatedUser.branch.displayName
      } : null
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Update user error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field });
    }
    res.status(400).json({ message: 'خطأ في تحديث المستخدم', error: err.message });
  }
});

router.delete('/:id', auth, authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }

    const user = await User.findById(req.params.id).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    if (user.role === 'admin') {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'لا يمكن حذف حسابات الإدارة' });
    }

    if (user.role === 'branch') {
      const branch = await Branch.findOne({ user: user._id }).session(session);
      if (branch) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'لا يمكن حذف المستخدم لأنه مرتبط بفرع' });
      }
    }

    await user.deleteOne({ session });
    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم حذف المستخدم' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Delete user error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/:id/reset-password', [
  auth,
  authorize('admin'),
  body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }

    const user = await User.findById(req.params.id).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    if (user.role === 'admin' && req.user.id !== req.params.id) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'لا يمكن إعادة تعيين كلمة مرور حسابات الإدارة' });
    }

    user.password = req.body.password;
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم إعادة تعيين كلمة المرور بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Reset password error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في إعادة تعيين كلمة المرور', error: err.message });
  }
});

module.exports = router;