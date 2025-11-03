const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Chef = require('../models/Chef');
const User = require('../models/User');
const Department = require('../models/department');
const mongoose = require('mongoose');

// دالة مساعدة لتعبئة البيانات
const populateChef = (query) => query
  .populate({
    path: 'user',
    select: '_id name nameEn username email phone role isActive createdAt updatedAt',
  })
  .populate({
    path: 'department',
    select: '_id name nameEn code description',
  });

// جلب جميع الشيفات
router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const chefs = await Chef.find({ status: 'active' })
      .then(populateChef)
      .lean();

    const validChefs = chefs.filter(chef => chef.user && chef.department?.length > 0);

    res.status(200).json(
      validChefs.map((chef) => ({
        _id: chef._id,
        user: {
          _id: chef.user._id,
          name: chef.user.name,
          nameEn: chef.user.nameEn,
          username: chef.user.username,
          email: chef.user.email,
          phone: chef.user.phone,
          isActive: chef.user.isActive,
          createdAt: chef.user.createdAt,
          updatedAt: chef.user.updatedAt,
        },
        department: chef.department.map(dept => ({
          _id: dept._id,
          name: dept.name,
          nameEn: dept.nameEn,
          code: dept.code,
          description: dept.description,
        })),
        createdAt: chef.createdAt,
        updatedAt: chef.updatedAt,
      }))
    );
  } catch (err) {
    console.error('خطأ في جلب الشيفات:', err);
    res.status(500).json({ message: 'خطأ في السيرفر' });
  }
});

// جلب شيف بناءً على معرف المستخدم
router.get('/by-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }
    const chefProfile = await Chef.findOne({ user: userId })
      .then(populateChef)
      .lean();
    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'لم يتم العثور على ملف الشيف' });
    }
    res.status(200).json({
      _id: chefProfile._id,
      user: {
        _id: chefProfile.user._id,
        name: chefProfile.user.name,
        nameEn: chefProfile.user.nameEn,
        username: chefProfile.user.username,
        email: chefProfile.user.email,
        phone: chefProfile.user.phone,
        isActive: chefProfile.user.isActive,
        createdAt: chefProfile.user.createdAt,
        updatedAt: chefProfile.user.updatedAt,
      },
      department: chefProfile.department.map(dept => ({
        _id: dept._id,
        name: dept.name,
        nameEn: dept.nameEn,
        code: dept.code,
        description: dept.description,
      })),
      createdAt: chefProfile.createdAt,
      updatedAt: chefProfile.updatedAt,
    });
  } catch (err) {
    console.error('خطأ في جلب ملف الشيف:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// جلب شيف بواسطة ID
router.get('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }
    const chef = await Chef.findById(id)
      .then(populateChef)
      .lean();
    if (!chef || !chef.user || !chef.department?.length) {
      return res.status(404).json({ success: false, message: 'الشيف غير موجود' });
    }
    res.status(200).json({
      _id: chef._id,
      user: {
        _id: chef.user._id,
        name: chef.user.name,
        nameEn: chef.user.nameEn,
        username: chef.user.username,
        email: chef.user.email,
        phone: chef.user.phone,
        isActive: chef.user.isActive,
        createdAt: chef.user.createdAt,
        updatedAt: chef.user.updatedAt,
      },
      department: chef.department.map(dept => ({
        _id: dept._id,
        name: dept.name,
        nameEn: dept.nameEn,
        code: dept.code,
        description: dept.description,
      })),
      createdAt: chef.createdAt,
      updatedAt: chef.updatedAt,
    });
  } catch (err) {
    console.error('خطأ في جلب تفاصيل الشيف:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// إنشاء شيف جديد
router.post('/', authMiddleware.auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { user, departments } = req.body;
    if (!user || typeof user !== 'object') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'بيانات المستخدم مطلوبة' });
    }
    if (!Array.isArray(departments) || departments.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'يجب اختيار قسم واحد على الأقل' });
    }

    const { name, nameEn, username, email, password } = user;
    if (!name || !nameEn || !username || !email || !password) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم الشيف، الاسم بالإنجليزية، اسم المستخدم، الإيميل، وكلمة المرور مطلوبة' });
    }

    const deptDocs = await Department.find({ _id: { $in: departments } }).session(session);
    if (deptDocs.length !== departments.length) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف قسم غير صالح' });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }

    const newUser = new User({
      name: name.trim(),
      nameEn: nameEn.trim(),
      username: username.trim(),
      email: email.trim(),
      phone: user.phone ? user.phone.trim() : '',
      password,
      role: 'chef',
      isActive: true,
    });
    await newUser.save({ session });

    const newChef = new Chef({
      user: newUser._id,
      department: departments,
      status: 'active',
    });
    await newChef.save({ session });

    await session.commitTransaction();
    session.endSession();

    await populateChef(newChef);
    res.status(201).json({
      _id: newChef._id,
      user: {
        _id: newChef.user._id,
        name: newChef.user.name,
        nameEn: newChef.user.nameEn,
        username: newChef.user.username,
        email: newChef.user.email,
        phone: newChef.user.phone,
        isActive: newChef.user.isActive,
        createdAt: newChef.user.createdAt,
        updatedAt: newChef.user.updatedAt,
      },
      department: newChef.department.map(d => ({
        _id: d._id,
        name: d.name,
        nameEn: d.nameEn,
        code: d.code,
        description: d.description,
      })),
      createdAt: newChef.createdAt,
      updatedAt: newChef.updatedAt,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('خطأ في إنشاء الشيف:', err);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }
    res.status(400).json({ message: 'خطأ في إنشاء الشيف', error: err.message });
  }
});

// تحديث بيانات شيف
router.put('/:id', authMiddleware.auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { user, departments } = req.body;
    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }
    if (!user || typeof user !== 'object') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'بيانات المستخدم مطلوبة' });
    }
    if (!Array.isArray(departments) || departments.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'يجب اختيار قسم واحد على الأقل' });
    }

    const { name, nameEn, username, email, phone, isActive } = user;
    if (!name || !nameEn || !username) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم الشيف، الاسم بالإنجليزية، واسم المستخدم مطلوبة' });
    }

    const chef = await Chef.findById(id).session(session);
    if (!chef) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'الشيف غير موجود' });
    }

    const deptDocs = await Department.find({ _id: { $in: departments } }).session(session);
    if (deptDocs.length !== departments.length) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف قسم غير صالح' });
    }

    const userDoc = await User.findById(chef.user).session(session);
    if (!userDoc) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const existingUser = await User.findOne({
      $or: [{ username: username.trim() }, { email: email ? email.trim() : '' }],
      _id: { $ne: userDoc._id },
    }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }

    userDoc.name = name.trim();
    userDoc.nameEn = nameEn.trim();
    userDoc.username = username.trim();
    userDoc.email = email ? email.trim() : undefined;
    userDoc.phone = phone ? phone.trim() : undefined;
    userDoc.isActive = isActive ?? userDoc.isActive;
    await userDoc.save({ session });

    chef.department = departments;
    await chef.save({ session });

    await session.commitTransaction();
    session.endSession();

    await populateChef(chef);
    res.status(200).json({
      _id: chef._id,
      user: {
        _id: chef.user._id,
        name: chef.user.name,
        nameEn: chef.user.nameEn,
        username: chef.user.username,
        email: chef.user.email,
        phone: chef.user.phone,
        isActive: chef.user.isActive,
        createdAt: chef.user.createdAt,
        updatedAt: chef.user.updatedAt,
      },
      department: chef.department.map(d => ({
        _id: d._id,
        name: d.name,
        nameEn: d.nameEn,
        code: d.code,
        description: d.description,
      })),
      createdAt: chef.createdAt,
      updatedAt: chef.updatedAt,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('خطأ في تحديث الشيف:', err);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'اسم المستخدم أو الإيميل مستخدم بالفعل' });
    }
    res.status(400).json({ message: 'خطأ في تحديث الشيف', error: err.message });
  }
});

// حذف شيف
router.delete('/:id', authMiddleware.auth, async (req, res) => {
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
    await chef.deleteOne({ session });
    await user.deleteOne({ session });
    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم حذف الشيف بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('خطأ في حذف الشيف:', err);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

// إعادة تعيين كلمة المرور
router.post('/:id/reset-password', authMiddleware.auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
    }
    if (!password || password.length < 6) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
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
    user.password = password;
    await user.save({ session });
    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم إعادة تعيين كلمة المرور بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('خطأ في إعادة تعيين كلمة المرور:', err);
    res.status(500).json({ message: 'خطأ في إعادة تعيين كلمة المرور', error: err.message });
  }
});

module.exports = router;