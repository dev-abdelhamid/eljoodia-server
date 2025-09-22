const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Chef = require('../models/Chef');
const User = require('../models/User');
const Department = require('../models/department');
const mongoose = require('mongoose');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const chefs = await Chef.find({ status: 'active' })
      .populate({
        path: 'user',
        select: '_id name nameEn username email phone role',
        match: { isActive: true, role: 'chef' },
      })
      .populate({
        path: 'department',
        select: 'name nameEn _id',
      });
    const validChefs = chefs.filter(chef => chef.user && chef.department);
    res.status(200).json(
      validChefs.map((chef) => ({
        _id: chef._id,
        user: {
          _id: chef.user._id,
          name: isRtl ? chef.user.name : chef.user.nameEn || chef.user.name,
          username: chef.user.username,
          email: chef.user.email,
          phone: chef.user.phone,
        },
        department: chef.department ? {
          _id: chef.department._id,
          name: isRtl ? chef.department.name : chef.department.nameEn || chef.department.name
        } : null,
      }))
    );
  } catch (err) {
    console.error('Get chefs error:', err);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/', authMiddleware.auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const isRtl = req.query.isRtl === 'true';
    const { user, department } = req.body;

    if (!user || typeof user !== 'object') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'بيانات المستخدم مطلوبة' });
    }
    if (!department) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'القسم مطلوب' });
    }

    const { name, nameEn, username, email, password } = user;
    if (!name || !username || !email || !password) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم المستخدم، الاسم، الإيميل، وكلمة المرور مطلوبة' });
    }

    const departmentExists = await Department.findById(department).session(session);
    if (!departmentExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف القسم غير صالح' });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }

    const newUser = new User({
      name: name.trim(),
      nameEn: nameEn ? nameEn.trim() : undefined,
      username: username.trim(),
      email: email.trim(),
      phone: user.phone ? user.phone.trim() : '',
      password,
      role: 'chef',
      department,
    });
    await newUser.save({ session });

    const newChef = new Chef({
      user: newUser._id,
      department,
      status: 'active',
    });
    await newChef.save({ session });

    await session.commitTransaction();
    session.endSession();

    await newChef.populate([
      { path: 'user', select: '_id name nameEn username email phone' },
      { path: 'department', select: 'name nameEn _id' },
    ]);

    res.status(201).json({
      _id: newChef._id,
      user: {
        _id: newChef.user._id,
        name: isRtl ? newChef.user.name : newChef.user.nameEn || newChef.user.name,
        username: newChef.user.username,
        email: newChef.user.email,
        phone: newChef.user.phone,
      },
      department: newChef.department ? {
        _id: newChef.department._id,
        name: isRtl ? newChef.department.name : newChef.department.nameEn || newChef.department.name
      } : null,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Create chef error:', err);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }
    res.status(400).json({ message: 'خطأ في إنشاء الشيف', error: err.message });
  }
});

router.get('/by-user/:userId', async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    const chefProfile = await Chef.findOne({ user: userId })
      .populate('user', 'username name nameEn')
      .populate('department', 'name nameEn code')
      .lean();

    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'لم يتم العثور على ملف الشيف' });
    }

    res.status(200).json({
      ...chefProfile,
      user: {
        ...chefProfile.user,
        name: isRtl ? chefProfile.user.name : chefProfile.user.nameEn || chefProfile.user.name,
      },
      department: chefProfile.department ? {
        ...chefProfile.department,
        name: isRtl ? chefProfile.department.name : chefProfile.department.nameEn || chefProfile.department.name
      } : null,
    });
  } catch (err) {
    console.error('خطأ في جلب ملف الشيف:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/reset-password/:userId', [
  authMiddleware.auth,
  authMiddleware.authorize('admin'),
  body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    user.password = req.body.password;
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم إعادة تعيين كلمة المرور بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Reset password error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في إعادة تعيين كلمة المرور', error: err.message });
  }
});

module.exports = router;