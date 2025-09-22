const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const Department = require('../models/department');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { search, limit = 10, page = 1, isRtl = 'true' } = req.query;
    const query = { isActive: true };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { nameEn: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const departments = await Department.find(query)
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .sort({ createdAt: -1 })
      .setOptions({ context: { isRtl: isRtl === 'true' } });

    const total = await Department.countDocuments(query);

    console.log(`[${new Date().toISOString()}] Departments fetched:`, departments);

    res.status(200).json({
      success: true,
      data: departments.map((dept) => ({
        _id: dept._id,
        name: dept.name,
        nameEn: dept.nameEn,
        code: dept.code,
        description: dept.description,
        isActive: dept.isActive,
        createdBy: dept.createdBy,
        createdAt: dept.createdAt,
        updatedAt: dept.updatedAt,
        displayName: dept.displayName,
      })),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get departments error:`, error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', authMiddleware.auth, [
  check('name', 'Name is required').not().isEmpty(),
  check('code', 'Code is required').not().isEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, nameEn, code, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const existingDepartment = await Department.findOne({ code });
    if (existingDepartment) {
      return res.status(400).json({ success: false, message: 'Department code already exists' });
    }

    const department = new Department({
      name: name.trim(),
      nameEn: nameEn ? nameEn.trim() : undefined,
      code: code.trim(),
      description: description ? description.trim() : undefined,
      createdBy: req.user._id,
    });

    await department.save();

    console.log(`[${new Date().toISOString()}] Department created:`, department);

    res.status(201).json({
      success: true,
      data: {
        _id: department._id,
        name: department.name,
        nameEn: department.nameEn,
        code: department.code,
        description: department.description,
        isActive: department.isActive,
        createdBy: department.createdBy,
        createdAt: department.createdAt,
        updatedAt: department.updatedAt,
        displayName: department.displayName,
      },
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Create department error:`, error);
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/:id', authMiddleware.auth, [
  check('name', 'Name is required').not().isEmpty(),
  check('code', 'Code is required').not().isEmpty(),
], async (req, res) => {
  try {
    const { id } = req.params;
    const { name, nameEn, code, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const existingDepartment = await Department.findOne({ code, _id: { $ne: id } });
    if (existingDepartment) {
      return res.status(400).json({ success: false, message: 'Department code already exists' });
    }

    const department = await Department.findByIdAndUpdate(
      id,
      {
        name: name.trim(),
        nameEn: nameEn ? nameEn.trim() : undefined,
        code: code.trim(),
        description: description ? description.trim() : undefined,
        updatedAt: new Date(),
      },
      { new: true, runValidators: true }
    ).setOptions({ context: { isRtl: req.query.isRtl === 'true' } });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    console.log(`[${new Date().toISOString()}] Department updated:`, department);

    res.status(200).json({
      success: true,
      data: {
        _id: department._id,
        name: department.name,
        nameEn: department.nameEn,
        code: department.code,
        description: department.description,
        isActive: department.isActive,
        createdBy: department.createdBy,
        createdAt: department.createdAt,
        updatedAt: department.updatedAt,
        displayName: department.displayName,
      },
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Update department error:`, error);
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const department = await Department.findById(id);
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    const productsInDepartment = await Product.find({ department: id, isActive: true });
    if (productsInDepartment.length > 0) {
      return res.status(400).json({ success: false, message: 'Cannot delete department with active products' });
    }

    await Department.findByIdAndUpdate(id, { isActive: false }, { new: true });

    console.log(`[${new Date().toISOString()}] Department deactivated:`, id);

    res.status(200).json({ success: true, message: 'Department deactivated' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Delete department error:`, error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;