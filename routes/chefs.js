const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Chef = require('../models/Chef');
const User = require('../models/User');
const Department = require('../models/department');
const mongoose = require('mongoose');
router.get('/chefs', auth, authorize('admin'), async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    const chefs = await Chef.find()
      .populate({
        path: 'user',
        select: 'name nameEn username email phone isActive createdAt updatedAt',
      })
      .populate('department', 'name nameEn code description');
    const transformedChefs = chefs.map(chef => ({
      ...chef.toObject({ context: { isRtl } }),
      user: chef.user ? {
        ...chef.user.toObject({ context: { isRtl } }),
        name: isRtl ? chef.user.name : chef.user.displayName || chef.user.name,
      } : null,
      department: chef.department ? {
        ...chef.department.toObject({ context: { isRtl } }),
        name: isRtl ? chef.department.name : chef.department.displayName || chef.department.name,
      } : null,
    }));
    res.status(200).json(transformedChefs);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chefs error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/chefs/:id', auth, authorize('admin'), async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }
    const chef = await Chef.findById(req.params.id)
      .populate({
        path: 'user',
        select: 'name nameEn username email phone isActive createdAt updatedAt',
      })
      .populate('department', 'name nameEn code description');
    if (!chef) {
      return res.status(404).json({ message: 'الشيف غير موجود' });
    }
    const transformedChef = {
      ...chef.toObject({ context: { isRtl } }),
      user: chef.user ? {
        ...chef.user.toObject({ context: { isRtl } }),
        name: isRtl ? chef.user.name : chef.user.displayName || chef.user.name,
      } : null,
      department: chef.department ? {
        ...chef.department.toObject({ context: { isRtl } }),
        name: isRtl ? chef.department.name : chef.department.displayName || chef.department.name,
      } : null,
    };
    res.status(200).json(transformedChef);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chef error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/chefs/by-user/:userId', auth, authorize('admin'), async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }
    const chef = await Chef.findOne({ user: req.params.userId })
      .populate({
        path: 'user',
        select: 'name nameEn username email phone isActive createdAt updatedAt',
      })
      .populate('department', 'name nameEn code description');
    if (!chef) {
      return res.status(404).json({ message: 'الشيف غير موجود' });
    }
    const transformedChef = {
      ...chef.toObject({ context: { isRtl } }),
      user: chef.user ? {
        ...chef.user.toObject({ context: { isRtl } }),
        name: isRtl ? chef.user.name : chef.user.displayName || chef.user.name,
      } : null,
      department: chef.department ? {
        ...chef.department.toObject({ context: { isRtl } }),
        name: isRtl ? chef.department.name : chef.department.displayName || chef.department.name,
      } : null,
    };
    res.status(200).json(transformedChef);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chef by user error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/chefs', [
  auth,
  authorize('admin'),
  body('user.name').notEmpty().withMessage('الاسم مطلوب'),
  body('user.username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('user.password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
  body('user.role').equals('chef').withMessage('الدور يجب أن يكون شيف'),
  body('department').notEmpty().withMessage('القسم مطلوب').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { user: userData, department } = req.body;
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;

    const existingUser = await User.findOne({ username: userData.username.trim() }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${userData.username}' مستخدم بالفعل` });
    }

    if (userData.email) {
      const existingEmail = await User.findOne({ email: userData.email.trim().toLowerCase() }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${userData.email}' مستخدم بالفعل` });
      }
    }

    const existingDepartment = await Department.findById(department).session(session);
    if (!existingDepartment) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'القسم غير موجود' });
    }

    const newUser = new User({
      name: userData.name.trim(),
      nameEn: userData.nameEn ? userData.nameEn.trim() : undefined,
      username: userData.username.trim(),
      password: userData.password,
      role: 'chef',
      email: userData.email ? userData.email.trim().toLowerCase() : undefined,
      phone: userData.phone ? userData.phone.trim() : undefined,
      department,
      isActive: userData.isActive ?? true,
    });
    await newUser.save({ session });

    const newChef = new Chef({
      user: newUser._id,
      department,
    });
    await newChef.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedChef = await Chef.findById(newChef._id)
      .populate({
        path: 'user',
        select: 'name nameEn username email phone isActive createdAt updatedAt',
      })
      .populate('department', 'name nameEn code description');

    res.status(201).json({
      ...populatedChef.toObject({ context: { isRtl } }),
      user: populatedChef.user ? {
        ...populatedChef.user.toObject({ context: { isRtl } }),
        name: isRtl ? populatedChef.user.name : populatedChef.user.displayName || populatedChef.user.name,
      } : null,
      department: populatedChef.department ? {
        ...populatedChef.department.toObject({ context: { isRtl } }),
        name: isRtl ? populatedChef.department.name : populatedChef.department.displayName || populatedChef.department.name,
      } : null,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Create chef error:`, err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field, value: err.keyValue[field] });
    }
    res.status(400).json({ message: 'خطأ في إنشاء الشيف', error: err.message });
  }
});

router.put('/chefs/:id', [
  auth,
  authorize('admin'),
  body('user.name').notEmpty().withMessage('الاسم مطلوب'),
  body('user.username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('department').notEmpty().withMessage('القسم مطلوب').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { user: userData, department } = req.body;
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;

    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }

    const chef = await Chef.findById(req.params.id).session(session);
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

    const existingUser = await User.findOne({ username: userData.username.trim(), _id: { $ne: user._id } }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${userData.username}' مستخدم بالفعل` });
    }

    if (userData.email) {
      const existingEmail = await User.findOne({ email: userData.email.trim().toLowerCase(), _id: { $ne: user._id } }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${userData.email}' مستخدم بالفعل` });
      }
    }

    const existingDepartment = await Department.findById(department).session(session);
    if (!existingDepartment) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'القسم غير موجود' });
    }

    user.name = userData.name.trim();
    user.nameEn = userData.nameEn ? userData.nameEn.trim() : undefined;
    user.username = userData.username.trim();
    user.email = userData.email ? userData.email.trim().toLowerCase() : undefined;
    user.phone = userData.phone ? userData.phone.trim() : undefined;
    user.department = department;
    user.isActive = userData.isActive ?? user.isActive;
    await user.save({ session });

    chef.department = department;
    await chef.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedChef = await Chef.findById(chef._id)
      .populate({
        path: 'user',
        select: 'name nameEn username email phone isActive createdAt updatedAt',
      })
      .populate('department', 'name nameEn code description');

    res.status(200).json({
      ...populatedChef.toObject({ context: { isRtl } }),
      user: populatedChef.user ? {
        ...populatedChef.user.toObject({ context: { isRtl } }),
        name: isRtl ? populatedChef.user.name : populatedChef.user.displayName || populatedChef.user.name,
      } : null,
      department: populatedChef.department ? {
        ...populatedChef.department.toObject({ context: { isRtl } }),
        name: isRtl ? populatedChef.department.name : populatedChef.department.displayName || populatedChef.department.name,
      } : null,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Update chef error:`, err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field, value: err.keyValue[field] });
    }
    res.status(400).json({ message: 'خطأ في تحديث الشيف', error: err.message });
  }
});

router.delete('/chefs/:id', auth, authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }

    const chef = await Chef.findById(req.params.id).session(session);
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

    await chef.deleteOne({ session });
    await user.deleteOne({ session });

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم حذف الشيف بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Delete chef error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/chefs/:id/reset-password', [
  auth,
  authorize('admin'),
  body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }

    const chef = await Chef.findById(req.params.id).session(session);
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
    console.error(`[${new Date().toISOString()}] Reset chef password error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في إعادة تعيين كلمة المرور', error: err.message });
  }
});

router.get('/chefs/:id/statistics', auth, authorize('admin'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }

    const chef = await Chef.findById(req.params.id);
    if (!chef) {
      return res.status(404).json({ message: 'الشيف غير موجود' });
    }

    // Placeholder statistics (replace with actual data from Order model or Statistics model)
    const stats = {
      ordersCompleted: 120, // Example data
      averagePrepTime: 15, // Example data (minutes)
      rating: 4.5, // Example data
      monthlyPerformance: [
        { month: 'Jan', orders: 20 },
        { month: 'Feb', orders: 25 },
        { month: 'Mar', orders: 30 },
        { month: 'Apr', orders: 15 },
        { month: 'May', orders: 22 },
        { month: 'Jun', orders: 28 },
      ],
    };

    res.status(200).json(stats);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get chef statistics error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;