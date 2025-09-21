const express = require('express');
const { body } = require('express-validator');
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const Branch = require('../models/Branch');
const User = require('../models/User');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const { isRtl = 'true' } = req.query; // Support isRtl query param
    const branches = await Branch.find()
      .populate('user', 'name nameEn username email phone isActive branch')
      .populate('createdBy', 'name nameEn username');
    const transformedBranches = branches.map(branch => ({
      ...branch.toObject(),
      name: isRtl === 'true' ? branch.name : branch.displayName,
      user: branch.user ? {
        ...branch.user,
        name: isRtl === 'true' ? branch.user.name : branch.user.displayName
      } : null,
      createdBy: branch.createdBy ? {
        ...branch.createdBy,
        name: isRtl === 'true' ? branch.createdBy.name : branch.createdBy.displayName
      } : null
    }));
    res.status(200).json(transformedBranches);
  } catch (err) {
    console.error('Get branches error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const { isRtl = 'true' } = req.query;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'معرف الفرع غير صالح' });
    }
    const branch = await Branch.findById(req.params.id)
      .populate('user', 'name nameEn username email phone isActive branch')
      .populate('createdBy', 'name nameEn username');
    if (!branch) {
      return res.status(404).json({ message: 'الفرع غير موجود' });
    }
    const transformedBranch = {
      ...branch.toObject(),
      name: isRtl === 'true' ? branch.name : branch.displayName,
      user: branch.user ? {
        ...branch.user,
        name: isRtl === 'true' ? branch.user.name : branch.user.displayName
      } : null,
      createdBy: branch.createdBy ? {
        ...branch.createdBy,
        name: isRtl === 'true' ? branch.createdBy.name : branch.createdBy.displayName
      } : null
    };
    res.status(200).json(transformedBranch);
  } catch (err) {
    console.error('Get branch error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/check-email', auth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'الإيميل مطلوب' });
    }
    const existingEmail = await User.findOne({ email: email.trim().toLowerCase() });
    res.status(200).json({ available: !existingEmail });
  } catch (err) {
    console.error('Check email error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/', [
  auth,
  authorize('admin'),
  body('name').notEmpty().withMessage('الاسم مطلوب'),
  body('code').notEmpty().withMessage('الكود مطلوب'),
  body('address').notEmpty().withMessage('العنوان مطلوب'),
  body('city').notEmpty().withMessage('المدينة مطلوبة'),
  body('user.name').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('user.username').notEmpty().withMessage('اسم المستخدم للفرع مطلوب'),
  body('user.password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, nameEn, code, address, city, phone, user } = req.body;

    if (!req.user.id || !mongoose.isValidObjectId(req.user.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم المنشئ غير صالح' });
    }

    if (!name || !code || !address || !city || !user?.name || !user?.username || !user?.password) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'الاسم، الكود، العنوان، المدينة، اسم المستخدم، واسم المستخدم للفرع، وكلمة المرور مطلوبة' });
    }

    const existingUser = await User.findOne({ username: user.username.trim() }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${user.username}' مستخدم بالفعل` });
    }

    const existingBranch = await Branch.findOne({ code: code.trim() }).session(session);
    if (existingBranch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `كود الفرع '${code}' مستخدم بالفعل` });
    }

    if (user.email) {
      const existingEmail = await User.findOne({ email: user.email.trim().toLowerCase() }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${user.email}' مستخدم بالفعل` });
      }
    }

    const newUser = new User({
      name: user.name.trim(),
      nameEn: user.nameEn ? user.nameEn.trim() : undefined,
      username: user.username.trim(),
      password: user.password,
      role: 'branch',
      email: user.email ? user.email.trim().toLowerCase() : undefined,
      phone: user.phone ? user.phone.trim() : undefined,
      isActive: user.isActive ?? true,
      branch: null,
    });
    await newUser.save({ session });

    const branch = new Branch({
      name: name.trim(),
      nameEn: nameEn ? nameEn.trim() : undefined,
      code: code.trim(),
      address: address.trim(),
      city: city.trim(),
      phone: phone ? phone.trim() : undefined,
      user: newUser._id,
      createdBy: req.user.id,
      isActive: true,
    });
    await branch.save({ session });

    newUser.branch = branch._id;
    await newUser.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedBranch = await Branch.findById(branch._id)
      .populate('user', 'name nameEn username email phone isActive branch')
      .populate('createdBy', 'name nameEn username');

    res.status(201).json({
      ...populatedBranch.toObject(),
      name: req.query.isRtl === 'true' ? populatedBranch.name : populatedBranch.displayName,
      user: populatedBranch.user ? {
        ...populatedBranch.user,
        name: req.query.isRtl === 'true' ? populatedBranch.user.name : populatedBranch.user.displayName
      } : null,
      createdBy: populatedBranch.createdBy ? {
        ...populatedBranch.createdBy,
        name: req.query.isRtl === 'true' ? populatedBranch.createdBy.name : populatedBranch.createdBy.displayName
      } : null
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Create branch error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field });
    }
    res.status(400).json({ message: 'خطأ في إنشاء الفرع', error: err.message });
  }
});

router.put('/:id', [
  auth,
  authorize('admin'),
  body('name').notEmpty().withMessage('الاسم مطلوب'),
  body('code').notEmpty().withMessage('الكود مطلوب'),
  body('address').notEmpty().withMessage('العنوان مطلوب'),
  body('city').notEmpty().withMessage('المدينة مطلوبة'),
  body('user.name').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('user.username').notEmpty().withMessage('اسم المستخدم للفرع مطلوب'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, nameEn, code, address, city, phone, user } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الفرع غير صالح' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'الفرع غير موجود' });
    }

    const existingBranch = await Branch.findOne({ code: code.trim(), _id: { $ne: req.params.id } }).session(session);
    if (existingBranch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `كود الفرع '${code}' مستخدم بالفعل` });
    }

    const existingUser = await User.findOne({ username: user.username.trim(), _id: { $ne: branch.user } }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${user.username}' مستخدم بالفعل` });
    }

    if (user.email) {
      const existingEmail = await User.findOne({ email: user.email.trim().toLowerCase(), _id: { $ne: branch.user } }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${user.email}' مستخدم بالفعل` });
      }
    }

    branch.name = name.trim();
    branch.nameEn = nameEn ? nameEn.trim() : undefined;
    branch.code = code.trim();
    branch.address = address.trim();
    branch.city = city.trim();
    branch.phone = phone ? phone.trim() : undefined;
    branch.isActive = user.isActive ?? branch.isActive;
    await branch.save({ session });

    if (branch.user) {
      const branchUser = await User.findById(branch.user).session(session);
      if (branchUser) {
        branchUser.name = user.name.trim();
        branchUser.nameEn = user.nameEn ? user.nameEn.trim() : undefined;
        branchUser.username = user.username.trim();
        branchUser.email = user.email ? user.email.trim().toLowerCase() : undefined;
        branchUser.phone = user.phone ? user.phone.trim() : undefined;
        branchUser.isActive = user.isActive ?? branchUser.isActive;
        await branchUser.save({ session });
      }
    }

    await session.commitTransaction();
    session.endSession();

    const populatedBranch = await Branch.findById(branch._id)
      .populate('user', 'name nameEn username email phone isActive branch')
      .populate('createdBy', 'name nameEn username');

    res.status(200).json({
      ...populatedBranch.toObject(),
      name: req.query.isRtl === 'true' ? populatedBranch.name : populatedBranch.displayName,
      user: populatedBranch.user ? {
        ...populatedBranch.user,
        name: req.query.isRtl === 'true' ? populatedBranch.user.name : populatedBranch.user.displayName
      } : null,
      createdBy: populatedBranch.createdBy ? {
        ...populatedBranch.createdBy,
        name: req.query.isRtl === 'true' ? populatedBranch.createdBy.name : populatedBranch.createdBy.displayName
      } : null
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Update branch error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field });
    }
    res.status(400).json({ message: 'خطأ في تحديث الفرع', error: err.message });
  }
});

router.delete('/:id', auth, authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف الفرع غير صالح' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'الفرع غير موجود' });
    }

    let ordersCount = 0, inventoryCount = 0;
    try {
      ordersCount = await mongoose.model('Order').countDocuments({ branch: branch._id }).session(session);
    } catch (err) {
      console.warn('Order model not found or query failed:', err.message);
    }
    try {
      inventoryCount = await mongoose.model('Inventory').countDocuments({ branch: branch._id }).session(session);
    } catch (err) {
      console.warn('Inventory model not found or query failed:', err.message);
    }

    if (ordersCount > 0 || inventoryCount > 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'لا يمكن حذف الفرع لوجود طلبات أو مخزون مرتبط' });
    }

    if (branch.user) {
      await User.deleteOne({ _id: branch.user, role: 'branch' }, { session });
    }

    await branch.deleteOne({ session });
    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم حذف الفرع والمستخدم المرتبط' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Delete branch error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/:id/reset-password', [
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
      return res.status(400).json({ message: 'معرف الفرع غير صالح' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'الفرع غير موجود' });
    }

    if (!branch.user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'لا يوجد مستخدم مرتبط بالفرع' });
    }

    const user = await User.findById(branch.user).session(session);
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
    console.error('Reset password error:', err.message, err.stack);
    res.status(500).json({ message: 'خطأ في إعادة تعيين كلمة المرور', error: err.message });
  }
});

module.exports = router;