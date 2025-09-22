const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Chef = require('../models/Chef');
const User = require('../models/User');
const Department = require('../models/department');
const mongoose = require('mongoose');

router.get('/', authMiddleware.auth, authMiddleware.authorize('admin'), async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const chefs = await Chef.find({ status: 'active' })
      .populate({
        path: 'user',
        select: '_id name nameEn username email phone role isActive',
        match: { isActive: true, role: 'chef' },
      })
      .populate({
        path: 'department',
        select: 'name nameEn _id code',
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
          isActive: chef.user.isActive,
        },
        department: chef.department ? {
          _id: chef.department._id,
          name: isRtl ? chef.department.name : chef.department.nameEn || chef.department.name,
          code: chef.department.code,
        } : null,
        status: chef.status,
      }))
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chefs error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/by-user/:userId', authMiddleware.auth, async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    const chefProfile = await Chef.findOne({ user: userId })
      .populate('user', 'username name nameEn email phone isActive')
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
        name: isRtl ? chefProfile.department.name : chefProfile.department.nameEn || chefProfile.department.name,
      } : null,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chef profile error:`, err.message, err.stack);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/', [
  authMiddleware.auth,
  authMiddleware.authorize('admin'),
  body('user.name').notEmpty().withMessage('الاسم مطلوب'),
  body('user.username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('user.email').isEmail().withMessage('الإيميل غير صالح'),
  body('user.password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
  body('department').notEmpty().withMessage('القسم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف القسم غير صالح');
    }
    return true;
  }),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const isRtl = req.query.isRtl === 'true';
    const { user, department } = req.body;

    const departmentExists = await Department.findById(department).session(session);
    if (!departmentExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'القسم غير موجود' });
    }

    const existingUser = await User.findOne({
      $or: [{ username: user.username.trim() }, { email: user.email.trim().toLowerCase() }],
    }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }

    const newUser = new User({
      name: user.name.trim(),
      nameEn: user.nameEn ? user.nameEn.trim() : undefined,
      username: user.username.trim(),
      email: user.email.trim().toLowerCase(),
      phone: user.phone ? user.phone.trim() : undefined,
      password: user.password,
      role: 'chef',
      department,
      isActive: user.isActive ?? true,
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
      { path: 'department', select: 'name nameEn _id code' },
    ]);

    res.status(201).json({
      _id: newChef._id,
      user: {
        _id: newChef.user._id,
        name: isRtl ? newChef.user.name : newChef.user.nameEn || newChef.user.name,
        username: newChef.user.username,
        email: newChef.user.email,
        phone: newChef.user.phone,
        isActive: newChef.user.isActive,
      },
      department: newChef.department ? {
        _id: newChef.department._id,
        name: isRtl ? newChef.department.name : newChef.department.nameEn || newChef.department.name,
        code: newChef.department.code,
      } : null,
      status: newChef.status,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Create chef error:`, err.message, err.stack);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }
    res.status(400).json({ message: 'خطأ في إنشاء الشيف', error: err.message });
  }
});

router.put('/:id', [
  authMiddleware.auth,
  authMiddleware.authorize('admin'),
  body('user.name').notEmpty().withMessage('الاسم مطلوب'),
  body('user.username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('user.email').isEmail().withMessage('الإيميل غير صالح'),
  body('department').notEmpty().withMessage('القسم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف القسم غير صالح');
    }
    return true;
  }),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { user, department } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }

    const chef = await Chef.findById(id).session(session);
    if (!chef) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'الشيف غير موجود' });
    }

    const departmentExists = await Department.findById(department).session(session);
    if (!departmentExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'القسم غير موجود' });
    }

    const userDoc = await User.findById(chef.user).session(session);
    if (!userDoc) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const existingUser = await User.findOne({
      $or: [{ username: user.username.trim() }, { email: user.email.trim().toLowerCase() }],
      _id: { $ne: userDoc._id },
    }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }

    userDoc.name = user.name.trim();
    userDoc.nameEn = user.nameEn ? user.nameEn.trim() : undefined;
    userDoc.username = user.username.trim();
    userDoc.email = user.email.trim().toLowerCase();
    userDoc.phone = user.phone ? user.phone.trim() : undefined;
    userDoc.department = department;
    userDoc.isActive = user.isActive ?? userDoc.isActive;
    await userDoc.save({ session });

    chef.department = department;
    chef.status = user.isActive ? 'active' : 'inactive';
    await chef.save({ session });

    await session.commitTransaction();
    session.endSession();

    await chef.populate([
      { path: 'user', select: '_id name nameEn username email phone isActive' },
      { path: 'department', select: 'name nameEn _id code' },
    ]);

    res.status(200).json({
      _id: chef._id,
      user: {
        _id: chef.user._id,
        name: isRtl ? chef.user.name : chef.user.nameEn || chef.user.name,
        username: chef.user.username,
        email: chef.user.email,
        phone: chef.user.phone,
        isActive: chef.user.isActive,
      },
      department: chef.department ? {
        _id: chef.department._id,
        name: isRtl ? chef.department.name : chef.department.nameEn || chef.department.name,
        code: chef.department.code,
      } : null,
      status: chef.status,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Update chef error:`, err.message, err.stack);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }
    res.status(400).json({ message: 'خطأ في تحديث الشيف', error: err.message });
  }
});

router.delete('/:id', authMiddleware.auth, authMiddleware.authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }

    const chef = await Chef.findById(id).session(session);
    if (!chef) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'الشيف غير موجود' });
    }

    const user = await User.findById(chef.user).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const ordersCount = await mongoose.model('Order').countDocuments({ 'items.assignedTo': chef.user }).session(session);
    if (ordersCount > 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'لا يمكن حذف الشيف لوجود طلبات مرتبطة' });
    }

    await user.deleteOne({ session });
    await chef.deleteOne({ session });

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم حذف الشيف بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Delete chef error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في حذف الشيف', error: err.message });
  }
});

router.post('/reset-password/:id', [
  authMiddleware.auth,
  authMiddleware.authorize('admin'),
  body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }

    const chef = await Chef.findById(id).session(session);
    if (!chef) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'الشيف غير موجود' });
    }

    const user = await User.findById(chef.user).session(session);
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