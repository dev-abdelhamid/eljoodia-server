const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Chef = require('../models/Chef');
const User = require('../models/User');
const Department = require('../models/department');
const mongoose = require('mongoose');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const chefs = await Chef.find({ status: 'active' })
      .populate({
        path: 'user',
        select: '_id name username email phone role',
        match: { isActive: true, role: 'chef' },
      })
      .populate({
        path: 'department',
        select: 'name _id',
      });
    console.log('Chefs fetched:', JSON.stringify(chefs, null, 2));
    const validChefs = chefs.filter(chef => chef.user && chef.department);
    res.status(200).json(
      validChefs.map((chef) => ({
        _id: chef._id,
        user: {
          _id: chef.user._id,
          name: chef.user.name,
          username: chef.user.username,
          email: chef.user.email,
          phone: chef.user.phone,
        },
        department: chef.department ? { _id: chef.department._id, name: chef.department.name } : null,
      }))
    );
  } catch (err) {
    console.error('Get chefs error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authMiddleware.auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    console.log('Received chef data:', JSON.stringify(req.body, null, 2));
    const { user, department } = req.body;

    if (!user || typeof user !== 'object') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'User object is required' });
    }
    if (!department) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Department is required' });
    }

    const { name, username, email, password } = user;
    if (!name || !username || !email || !password) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'User name, username, email, and password are required' });
    }

    const departmentExists = await Department.findById(department).session(session);
    if (!departmentExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Invalid department ID' });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Username or email already exists' });
    }

    const newUser = new User({
      name: name.trim(),
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
      { path: 'user', select: '_id name username email phone' },
      { path: 'department', select: 'name _id' },
    ]);

    res.status(201).json({
      _id: newChef._id,
      user: {
        _id: newChef.user._id,
        name: newChef.user.name,
        username: newChef.user.username,
        email: newChef.user.email,
        phone: newChef.user.phone,
      },
      department: newChef.department ? { _id: newChef.department._id, name: newChef.department.name } : null,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Create chef error:', err);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Username or email already exists' });
    }
    res.status(400).json({ message: 'Error creating chef', error: err.message });
  }
});

// نقطة نهاية لجلب ملف الشيف بناءً على userId
router.get('/by-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'معرف المستخدم غير صالح' });
    }

    const chefProfile = await Chef.findOne({ user: userId })
      .populate('user', 'username name')
      .populate('department', 'name code')
      .lean();

    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'لم يتم العثور على ملف الشيف' });
    }

    res.status(200).json(chefProfile);
  } catch (err) {
    console.error('خطأ في جلب ملف الشيف:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;