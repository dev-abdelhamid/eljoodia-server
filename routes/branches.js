const express = require('express');
const { body } = require('express-validator');
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const Branch = require('../models/Branch');
const User = require('../models/User');
const { localizeData } = require('../utils/localize');
const cors = require('cors');

const router = express.Router();

// Enable CORS for specific origin
router.use(
  cors({
    origin: 'https://eljoodia-client.vercel.app',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Handle CORS preflight requests
router.options('*', cors());

router.get('/', auth, async (req, res) => {
  try {
    const { status, lang = 'en' } = req.query;
    const query = status && status !== 'all' ? { isActive: status === 'active' } : {};
    const branches = await Branch.find(query)
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');
    const localizedBranches = branches.map((branch) =>
      localizeData(branch, lang, ['name', 'address', 'city', 'user.name', 'createdBy.name'])
    );
    console.log('Fetched branches:', JSON.stringify(localizedBranches, null, 2));
    res.status(200).json(localizedBranches);
  } catch (err) {
    console.error('Get branches error:', err.message, err.stack);
    res.status(500).json({ message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const { lang = 'en' } = req.query;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    const branch = await Branch.findById(req.params.id)
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');
    if (!branch) {
      return res.status(404).json({ message: lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
    }
    console.log('Fetched branch:', JSON.stringify(branch, null, 2));
    res.status(200).json(localizeData(branch, lang, ['name', 'address', 'city', 'user.name', 'createdBy.name']));
  } catch (err) {
    console.error('Get branch error:', err.message, err.stack);
    res.status(500).json({ message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
});

router.post('/check-email', auth, async (req, res) => {
  try {
    const { email } = req.body;
    const { lang = 'en' } = req.query;
    if (!email) {
      return res.status(400).json({ message: lang === 'ar' ? 'الإيميل مطلوب' : 'Email is required' });
    }
    const existingEmail = await User.findOne({ email: email.trim().toLowerCase() });
    res.status(200).json({ available: !existingEmail });
  } catch (err) {
    console.error('Check email error:', err.message, err.stack);
    res.status(500).json({ message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
});

router.post('/', [
  auth,
  authorize('admin'),
  body('name.ar').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'اسم الفرع بالعربية مطلوب' : 'Arabic name is required'),
  body('name.en').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'اسم الفرع بالإنجليزية مطلوب' : 'English name is required'),
  body('code').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'كود الفرع مطلوب' : 'Code is required'),
  body('address.ar').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'العنوان بالعربية مطلوب' : 'Arabic address is required'),
  body('address.en').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'العنوان بالإنجليزية مطلوب' : 'English address is required'),
  body('city.ar').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'المدينة بالعربية مطلوبة' : 'Arabic city is required'),
  body('city.en').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'المدينة بالإنجليزية مطلوبة' : 'English city is required'),
  body('user.name.ar').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'اسم المستخدم بالعربية مطلوب' : 'Arabic user name is required'),
  body('user.name.en').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'اسم المستخدم بالإنجليزية مطلوب' : 'English user name is required'),
  body('user.username').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'اسم المستخدم مطلوب' : 'Username is required'),
  body('user.password').isLength({ min: 6 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' : 'Password must be at least 6 characters'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, code, address, city, phone, isActive = true, user } = req.body;
    const { lang = 'en' } = req.query;

    if (!req.user.id || !mongoose.isValidObjectId(req.user.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: lang === 'ar' ? 'معرف المستخدم المنشئ غير صالح' : 'Invalid creator ID' });
    }

    const existingUser = await User.findOne({ username: user.username.trim() }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: lang === 'ar' ? `اسم المستخدم '${user.username}' مستخدم بالفعل` : `Username '${user.username}' is already taken` });
    }

    const existingBranch = await Branch.findOne({ code: code.trim() }).session(session);
    if (existingBranch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: lang === 'ar' ? `كود الفرع '${code}' مستخدم بالفعل` : `Branch code '${code}' is already taken` });
    }

    if (user.email) {
      const existingEmail = await User.findOne({ email: user.email.trim().toLowerCase() }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: lang === 'ar' ? `الإيميل '${user.email}' مستخدم بالفعل` : `Email '${user.email}' is already taken` });
      }
    }

    const newUser = new User({
      name: { ar: user.name.ar.trim(), en: user.name.en.trim() },
      username: user.username.trim(),
      password: user.password,
      role: 'branch',
      email: user.email ? user.email.trim().toLowerCase() : null,
      phone: user.phone ? user.phone.trim() : null,
      isActive: user.isActive ?? true,
      branch: null,
    });
    await newUser.save({ session });

    const branch = new Branch({
      name: { ar: name.ar.trim(), en: name.en.trim() },
      code: code.trim(),
      address: { ar: address.ar.trim(), en: address.en.trim() },
      city: { ar: city.ar.trim(), en: city.en.trim() },
      phone: phone ? phone.trim() : null,
      user: newUser._id,
      createdBy: req.user.id,
      isActive,
    });
    await branch.save({ session });

    newUser.branch = branch._id;
    await newUser.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedBranch = await Branch.findById(branch._id)
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');
    const localizedBranch = localizeData(populatedBranch, lang, ['name', 'address', 'city', 'user.name', 'createdBy.name']);
    console.log('Created branch:', JSON.stringify(localizedBranch, null, 2));
    res.status(201).json(localizedBranch);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Create branch error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: lang === 'ar' ? `${field} مستخدم بالفعل` : `${field} is already taken`, field });
    }
    res.status(400).json({ message: lang === 'ar' ? 'خطأ في إنشاء الفرع' : 'Error creating branch', error: err.message });
  }
});

router.put('/:id', [
  auth,
  authorize('admin'),
  body('name.ar').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'اسم الفرع بالعربية مطلوب' : 'Arabic name is required'),
  body('name.en').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'اسم الفرع بالإنجليزية مطلوب' : 'English name is required'),
  body('code').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'كود الفرع مطلوب' : 'Code is required'),
  body('address.ar').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'العنوان بالعربية مطلوب' : 'Arabic address is required'),
  body('address.en').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'العنوان بالإنجليزية مطلوب' : 'English address is required'),
  body('city.ar').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'المدينة بالعربية مطلوبة' : 'Arabic city is required'),
  body('city.en').notEmpty().withMessage((_, { req }) => req.query.lang === 'ar' ? 'المدينة بالإنجليزية مطلوبة' : 'English city is required'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, code, address, city, phone, isActive = true, user } = req.body;
    const { lang = 'en' } = req.query;

    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
    }

    const existingBranch = await Branch.findOne({ code: code.trim(), _id: { $ne: req.params.id } }).session(session);
    if (existingBranch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: lang === 'ar' ? `كود الفرع '${code}' مستخدم بالفعل` : `Branch code '${code}' is already taken` });
    }

    if (user && user.username) {
      const existingUser = await User.findOne({
        username: user.username.trim(),
        _id: { $ne: branch.user },
      }).session(session);
      if (existingUser) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: lang === 'ar' ? `اسم المستخدم '${user.username}' مستخدم بالفعل` : `Username '${user.username}' is already taken` });
      }
    }

    if (user && user.email) {
      const existingEmail = await User.findOne({
        email: user.email.trim().toLowerCase(),
        _id: { $ne: branch.user },
      }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: lang === 'ar' ? `الإيميل '${user.email}' مستخدم بالفعل` : `Email '${user.email}' is already taken` });
      }
    }

    branch.name = { ar: name.ar.trim(), en: name.en.trim() };
    branch.code = code.trim();
    branch.address = { ar: address.ar.trim(), en: address.en.trim() };
    branch.city = { ar: city.ar.trim(), en: city.en.trim() };
    branch.phone = phone ? phone.trim() : null;
    branch.isActive = isActive;
    await branch.save({ session });

    if (user && branch.user) {
      const branchUser = await User.findById(branch.user).session(session);
      if (!branchUser) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ message: lang === 'ar' ? 'المستخدم المرتبط بالفرع غير موجود' : 'User associated with branch not found' });
      }
      branchUser.name = user.name ? { ar: user.name.ar.trim(), en: user.name.en.trim() } : branchUser.name;
      branchUser.username = user.username ? user.username.trim() : branchUser.username;
      branchUser.email = user.email ? user.email.trim().toLowerCase() : branchUser.email;
      branchUser.phone = user.phone ? user.phone.trim() : branchUser.phone;
      branchUser.isActive = user.isActive !== undefined ? user.isActive : branchUser.isActive;
      await branchUser.save({ session });
    }

    await session.commitTransaction();
    session.endSession();

    const populatedBranch = await Branch.findById(branch._id)
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');
    const localizedBranch = localizeData(populatedBranch, lang, ['name', 'address', 'city', 'user.name', 'createdBy.name']);
    console.log('Updated branch:', JSON.stringify(localizedBranch, null, 2));
    res.status(200).json(localizedBranch);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Update branch error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: lang === 'ar' ? `${field} مستخدم بالفعل` : `${field} is already taken`, field });
    }
    res.status(400).json({ message: lang === 'ar' ? 'خطأ في تحديث الفرع' : 'Error updating branch', error: err.message });
  }
});

router.post('/:id/reset-password', [
  auth,
  authorize('admin'),
  body('password').isLength({ min: 6 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' : 'Password must be at least 6 characters'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { password } = req.body;
    const { lang = 'en' } = req.query;

    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
    }

    if (!branch.user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: lang === 'ar' ? 'لا يوجد مستخدم مرتبط بهذا الفرع' : 'No user associated with this branch' });
    }

    const branchUser = await User.findById(branch.user).session(session);
    if (!branchUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: lang === 'ar' ? 'المستخدم المرتبط بالفرع غير موجود' : 'User associated with branch not found' });
    }

    branchUser.password = password;
    await branchUser.save({ session });

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: lang === 'ar' ? 'تم إعادة تعيين كلمة المرور بنجاح' : 'Password reset successfully' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Reset password error:', err.message, err.stack);
    res.status(500).json({ message: lang === 'ar' ? 'خطأ في إعادة تعيين كلمة المرور' : 'Error resetting password', error: err.message });
  }
});

router.delete('/:id', auth, authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { lang = 'en' } = req.query;
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: lang === 'ar' ? 'الفرع غير موجود' : 'Branch not found' });
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
      return res.status(400).json({ message: lang === 'ar' ? 'لا يمكن حذف الفرع لوجود طلبات أو مخزون مرتبط' : 'Cannot delete branch with associated orders or inventory' });
    }

    if (branch.user) {
      await User.deleteOne({ _id: branch.user, role: 'branch' }, { session });
    }

    await branch.deleteOne({ session });
    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: lang === 'ar' ? 'تم حذف الفرع والمستخدم المرتبط' : 'Branch and associated user deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Delete branch error:', err.message, err.stack);
    res.status(500).json({ message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
});

module.exports = router;