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
        select: '_id name nameEn username email phone role isActive createdAt updatedAt',
        match: { isActive: true, role: 'chef' },
      })
      .populate({
        path: 'department',
        select: '_id name nameEn code description',
      })
      .setOptions({ context: { isRtl: isRtl } });

    console.log('Chefs fetched:', JSON.stringify(chefs, null, 2));
    const validChefs = chefs.filter(chef => chef.user && chef.department);
    res.status(200).json({
      success: true,
      data: validChefs.map((chef) => ({
        _id: chef._id,
        user: {
          _id: chef.user._id,
          name: chef.user.name,
          nameEn: chef.user.nameEn,
          username: chef.user.username,
          email: chef.user.email,
          phone: chef.user.phone,
          role: chef.user.role,
          isActive: chef.user.isActive,
          createdAt: chef.user.createdAt,
          updatedAt: chef.user.updatedAt,
          displayName: chef.user.displayName,
        },
        department: chef.department ? {
          _id: chef.department._id,
          name: chef.department.name,
          nameEn: chef.department.nameEn,
          code: chef.department.code,
          description: chef.department.description,
          displayName: chef.department.displayName,
        } : null,
        status: chef.status,
        createdAt: chef.createdAt,
        updatedAt: chef.updatedAt,
      })),
    });
  } catch (err) {
    console.error('Get chefs error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Server error' });
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
      return res.status(400).json({ success: false, message: 'User object is required' });
    }
    if (!department) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Department is required' });
    }

    const { name, nameEn, username, email, password } = user;
    if (!name || !nameEn || !username || !email || !password) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'User name, nameEn, username, email, and password are required' });
    }

    const departmentExists = await Department.findById(department).session(session);
    if (!departmentExists) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Invalid department ID' });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Username or email already exists' });
    }

    const newUser = new User({
      name: name.trim(),
      nameEn: nameEn.trim(),
      username: username.trim(),
      email: email.trim(),
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
      { path: 'user', select: '_id name nameEn username email phone role isActive createdAt updatedAt' },
      { path: 'department', select: '_id name nameEn code description' },
    ]);

    res.status(201).json({
      success: true,
      data: {
        _id: newChef._id,
        user: {
          _id: newChef.user._id,
          name: newChef.user.name,
          nameEn: newChef.user.nameEn,
          username: newChef.user.username,
          email: newChef.user.email,
          phone: newChef.user.phone,
          role: newChef.user.role,
          isActive: newChef.user.isActive,
          createdAt: newChef.user.createdAt,
          updatedAt: newChef.user.updatedAt,
          displayName: newChef.user.displayName,
        },
        department: newChef.department ? {
          _id: newChef.department._id,
          name: newChef.department.name,
          nameEn: newChef.department.nameEn,
          code: newChef.department.code,
          description: newChef.department.description,
          displayName: newChef.department.displayName,
        } : null,
        status: newChef.status,
        createdAt: newChef.createdAt,
        updatedAt: newChef.updatedAt,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Create chef error:', err.message, err.stack);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Username or email already exists' });
    }
    res.status(400).json({ success: false, message: 'Error creating chef', error: err.message });
  }
});

router.get('/by-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const isRtl = req.query.isRtl === 'true';
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    const chefProfile = await Chef.findOne({ user: userId })
      .populate('user', 'name nameEn username email phone role isActive createdAt updatedAt')
      .populate('department', 'name nameEn code description')
      .setOptions({ context: { isRtl } });

    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'Chef profile not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        _id: chefProfile._id,
        user: {
          _id: chefProfile.user._id,
          name: chefProfile.user.name,
          nameEn: chefProfile.user.nameEn,
          username: chefProfile.user.username,
          email: chefProfile.user.email,
          phone: chefProfile.user.phone,
          role: chefProfile.user.role,
          isActive: chefProfile.user.isActive,
          createdAt: chefProfile.user.createdAt,
          updatedAt: chefProfile.user.updatedAt,
          displayName: chefProfile.user.displayName,
        },
        department: chefProfile.department ? {
          _id: chefProfile.department._id,
          name: chefProfile.department.name,
          nameEn: chefProfile.department.nameEn,
          code: chefProfile.department.code,
          description: chefProfile.department.description,
          displayName: chefProfile.department.displayName,
        } : null,
        status: chefProfile.status,
        createdAt: chefProfile.createdAt,
        updatedAt: chefProfile.updatedAt,
      },
    });
  } catch (err) {
    console.error('Get chef by user error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;