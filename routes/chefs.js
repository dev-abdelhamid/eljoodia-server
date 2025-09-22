const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Chef = require('../models/Chef');
const User = require('../models/User');
const Department = require('../models/department');
const mongoose = require('mongoose');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    const chefs = await Chef.find({ status: 'active' })
      .populate({
        path: 'user',
        select: '_id name nameEn username email phone role isActive',
        match: { isActive: true, role: 'chef' },
      })
      .populate({
        path: 'department',
        select: 'name nameEn code description',
      });
    const validChefs = chefs.filter(chef => chef.user && chef.department);
    res.status(200).json(
      validChefs.map((chef) => ({
        id: chef._id.toString(),
        user: {
          id: chef.user._id.toString(),
          name: isRtl ? chef.user.name : chef.user.displayName,
          username: chef.user.username,
          email: chef.user.email,
          phone: chef.user.phone,
          isActive: chef.user.isActive,
        },
        department: chef.department
          ? {
              id: chef.department._id.toString(),
              name: isRtl ? chef.department.name : chef.department.displayName,
              code: chef.department.code,
              description: chef.department.description,
            }
          : null,
        status: chef.status,
      }))
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chefs error:`, err.message, err.stack);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/by-user/:userId', authMiddleware.auth, async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    const chefProfile = await Chef.findOne({ user: userId })
      .populate('user', 'username name nameEn email phone isActive')
      .populate('department', 'name nameEn code description')
      .lean();

    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'لم يتم العثور على ملف الشيف' });
    }

    res.status(200).json({
      success: true,
      chef: {
        id: chefProfile._id.toString(),
        user: {
          id: chefProfile.user._id.toString(),
          username: chefProfile.user.username,
          name: isRtl ? chefProfile.user.name : chefProfile.user.nameEn || chefProfile.user.name,
          email: chefProfile.user.email,
          phone: chefProfile.user.phone,
          isActive: chefProfile.user.isActive,
        },
        department: chefProfile.department
          ? {
              id: chefProfile.department._id.toString(),
              name: isRtl ? chefProfile.department.name : chefProfile.department.nameEn || chefProfile.department.name,
              code: chefProfile.department.code,
              description: chefProfile.department.description,
            }
          : null,
        status: chefProfile.status,
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chef profile error:`, err.message, err.stack);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// باقي الـ endpoints (POST, PUT, DELETE, reset-password) تبقى زي ما هي مع تحسينات مشابهة لو لازم
router.post('/', authMiddleware.auth, authMiddleware.authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    const { user, department } = req.body;

    if (!user || typeof user !== 'object') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'بيانات المستخدم مطلوبة' });
    }
    if (!department) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'القسم مطلوب' });
    }

    const { name, username, email, password } = user;
    if (!name || !username || !email || !password) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'اسم المستخدم، اليوزرنيم، الإيميل، وكلمة المرور مطلوبة' });
    }

    const departmentExists = await Department.findById(department).session(session);
    if (!departmentExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'القسم غير موجود' });
    }

    const existingUser = await User.findOne({ $or: [{ username: username.trim() }, { email: email.trim().toLowerCase() }] }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }

    const newUser = new User({
      name: name.trim(),
      username: username.trim(),
      email: email.trim().toLowerCase(),
      phone: user.phone ? user.phone.trim() : undefined,
      password,
      role: 'chef',
      department,
      isActive: true,
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
      { path: 'user', select: '_id name nameEn username email phone isActive' },
      { path: 'department', select: 'name nameEn code description' },
    ]);

    res.status(201).json({
      success: true,
      chef: {
        id: newChef._id.toString(),
        user: {
          id: newChef.user._id.toString(),
          name: isRtl ? newChef.user.name : newChef.user.displayName,
          username: newChef.user.username,
          email: newChef.user.email,
          phone: newChef.user.phone,
          isActive: newChef.user.isActive,
        },
        department: newChef.department
          ? {
              id: newChef.department._id.toString(),
              name: isRtl ? newChef.department.name : newChef.department.displayName,
              code: newChef.department.code,
              description: newChef.department.description,
            }
          : null,
        status: newChef.status,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Create chef error:`, err.message, err.stack);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }
    res.status(400).json({ success: false, message: 'خطأ في إنشاء الشيف', error: err.message });
  }
});

module.exports = router;