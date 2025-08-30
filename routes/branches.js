const express = require('express');
const { body } = require('express-validator');
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const Branch = require('../models/Branch');
const User = require('../models/User');
const bcrypt = require('bcryptjs');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const branches = await Branch.find()
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');
    console.log('Fetched branches:', JSON.stringify(branches, null, 2));
    res.status(200).json(branches);
  } catch (err) {
    console.error('Get branches error:', err.message, err.stack);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid branch ID' });
    }
    const branch = await Branch.findById(req.params.id)
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    console.log('Fetched branch:', JSON.stringify(branch, null, 2));
    res.status(200).json(branch);
  } catch (err) {
    console.error('Get branch error:', err.message, err.stack);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/check-email', auth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
    const existingEmail = await User.findOne({ email: email.trim().toLowerCase() });
    res.status(200).json({ available: !existingEmail });
  } catch (err) {
    console.error('Check email error:', err.message, err.stack);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/', [
  auth,
  authorize('admin'),
  body('name.ar').notEmpty().withMessage('Branch name (Arabic) is required'),
  body('name.en').notEmpty().withMessage('Branch name (English) is required'),
  body('code').notEmpty().withMessage('Branch code is required'),
  body('address.ar').notEmpty().withMessage('Address (Arabic) is required'),
  body('address.en').notEmpty().withMessage('Address (English) is required'),
  body('city.ar').notEmpty().withMessage('City (Arabic) is required'),
  body('city.en').notEmpty().withMessage('City (English) is required'),
  body('username').notEmpty().withMessage('Username is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    console.log('Received branch data:', JSON.stringify(req.body, null, 2));
    const { name, code, address, city, phone, username, password, email } = req.body;

    if (!req.user.id || !mongoose.isValidObjectId(req.user.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Invalid creator ID' });
    }

    if (!name?.ar || !name?.en || !code || !address?.ar || !address?.en || !city?.ar || !city?.en || !username || !password) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Name (Arabic and English), code, address (Arabic and English), city (Arabic and English), username, and password are required' });
    }

    const existingUser = await User.findOne({ username: username.trim() }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `Username '${username}' is already in use` });
    }

    const existingBranch = await Branch.findOne({ code: code.trim() }).session(session);
    if (existingBranch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `Branch code '${code}' is already in use` });
    }

    if (email) {
      console.log('Checking email:', email.trim().toLowerCase());
      const existingEmail = await User.findOne({ email: email.trim().toLowerCase() }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `Email '${email}' is already in use` });
      }
    }

    const user = new User({
      name: { ar: name.ar.trim(), en: name.en.trim() },
      username: username.trim(),
      password,
      role: 'branch',
      email: email ? email.trim().toLowerCase() : null,
      phone: phone ? phone.trim() : null,
      isActive: true,
      branch: null,
    });
    await user.save({ session });
    console.log('Created user:', user);

    const branch = new Branch({
      name: { ar: name.ar.trim(), en: name.en.trim() },
      code: code.trim(),
      address: { ar: address.ar.trim(), en: address.en.trim() },
      city: { ar: city.ar.trim(), en: city.en.trim() },
      phone: phone ? phone.trim() : null,
      user: user._id,
      createdBy: req.user.id,
      isActive: true,
    });
    await branch.save({ session });
    console.log('Created branch:', branch);

    user.branch = branch._id;
    await user.save({ session });
    console.log('Updated user with branch:', user);

    await session.commitTransaction();
    session.endSession();

    const populatedBranch = await Branch.findById(branch._id)
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');

    if (!populatedBranch.user || !populatedBranch.user.branch || populatedBranch.user.branch.toString() !== branch._id.toString()) {
      console.error('Failed to link user to branch:', populatedBranch.user);
      return res.status(500).json({ message: 'Failed to link user to branch' });
    }

    res.status(201).json({
      _id: branch._id,
      name: branch.name,
      code: branch.code,
      address: branch.address,
      city: branch.city,
      phone: branch.phone,
      isActive: branch.isActive,
      user: {
        _id: populatedBranch.user._id,
        name: populatedBranch.user.name,
        username: populatedBranch.user.username,
        email: populatedBranch.user.email,
        phone: populatedBranch.user.phone,
        isActive: populatedBranch.user.isActive,
        branch: populatedBranch.user.branch,
      },
      createdBy: {
        _id: populatedBranch.createdBy._id,
        name: populatedBranch.createdBy.name,
        username: populatedBranch.createdBy.username,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Create branch error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} is already in use`, field });
    }
    res.status(400).json({ message: 'Error creating branch', error: err.message, details: err });
  }
});

router.put('/:id', [
  auth,
  authorize('admin'),
  body('name.ar').notEmpty().withMessage('Branch name (Arabic) is required'),
  body('name.en').notEmpty().withMessage('Branch name (English) is required'),
  body('code').notEmpty().withMessage('Branch code is required'),
  body('address.ar').notEmpty().withMessage('Address (Arabic) is required'),
  body('address.en').notEmpty().withMessage('Address (English) is required'),
  body('city.ar').notEmpty().withMessage('City (Arabic) is required'),
  body('city.en').notEmpty().withMessage('City (English) is required'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    console.log('Received update branch data:', JSON.stringify(req.body, null, 2));
    const { name, code, address, city, phone } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Invalid branch ID' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Branch not found' });
    }

    const existingBranch = await Branch.findOne({ code: code.trim(), _id: { $ne: req.params.id } }).session(session);
    if (existingBranch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `Branch code '${code}' is already in use` });
    }

    branch.name = { ar: name.ar.trim(), en: name.en.trim() };
    branch.code = code.trim();
    branch.address = { ar: address.ar.trim(), en: address.en.trim() };
    branch.city = { ar: city.ar.trim(), en: city.en.trim() };
    branch.phone = phone ? phone.trim() : null;
    await branch.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedBranch = await Branch.findById(branch._id)
      .populate('user', 'name username email phone isActive branch')
      .populate('createdBy', 'name username');

    res.status(200).json({
      _id: branch._id,
      name: branch.name,
      code: branch.code,
      address: branch.address,
      city: branch.city,
      phone: branch.phone,
      isActive: branch.isActive,
      user: populatedBranch.user ? {
        _id: populatedBranch.user._id,
        name: populatedBranch.user.name,
        username: populatedBranch.user.username,
        email: populatedBranch.user.email,
        phone: populatedBranch.user.phone,
        isActive: populatedBranch.user.isActive,
        branch: populatedBranch.user.branch,
      } : null,
      createdBy: populatedBranch.createdBy ? {
        _id: populatedBranch.createdBy._id,
        name: populatedBranch.createdBy.name,
        username: populatedBranch.createdBy.username,
      } : null,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Update branch error:', err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} is already in use`, field });
    }
    res.status(400).json({ message: 'Error updating branch', error: err.message, details: err });
  }
});

router.delete('/:id', auth, authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    console.log('Attempting to delete branch with ID:', req.params.id);
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Invalid branch ID' });
    }

    const branch = await Branch.findById(req.params.id).session(session);
    if (!branch) {
      console.log('Branch not found:', req.params.id);
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Branch not found' });
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
      return res.status(400).json({ message: 'Cannot delete branch with associated orders or inventory' });
    }

    console.log('Deleting associated user for branch:', branch._id);
    if (branch.user) {
      const deletedUser = await User.deleteOne({ _id: branch.user, role: 'branch' }, { session });
      console.log('User deletion result:', deletedUser);
      if (deletedUser.deletedCount === 0) {
        console.warn('No user found or deleted for branch:', branch._id);
      }
    }

    await branch.deleteOne({ session });
    console.log('Branch deleted successfully:', branch._id);

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'Branch and associated user deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Delete branch error:', err.message, err.stack);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.patch('/:id/reset-password', [
  auth,
  authorize('admin'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Invalid branch ID' });
    }

    const branch = await Branch.findById(id).session(session);
    if (!branch) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Branch not found' });
    }

    if (!branch.user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'No user associated with this branch' });
    }

    const user = await User.findById(branch.user).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Associated user not found' });
    }

    user.password = password;
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('Reset password error:', err.message, err.stack);
    res.status(500).json({ message: 'Error resetting password', error: err.message });
  }
});

module.exports = router;