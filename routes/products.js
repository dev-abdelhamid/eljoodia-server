const express = require('express');
const router = express.Router();
const { check } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const Product = require('../models/Product');
const Department = require('../models/department');
const mongoose = require('mongoose');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { department, search, page = 1, limit = 100, isRtl = 'true' } = req.query;
    const query = { isActive: true };

    if (department && mongoose.isValidObjectId(department)) {
      query.department = department;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { nameEn: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const products = await Product.find(query)
      .populate('department', 'name nameEn code')
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .setOptions({ context: { isRtl: isRtl === 'true' } });

    const total = await Product.countDocuments(query);

    res.status(200).json({
      success: true,
      data: products.map(product => ({
        _id: product._id,
        name: product.name,
        nameEn: product.nameEn,
        code: product.code,
        department: product.department,
        price: product.price,
        unit: product.unit,
        unitEn: product.unitEn,
        description: product.description,
        image: product.image,
        ingredients: product.ingredients,
        preparationTime: product.preparationTime,
        isActive: product.isActive,
        createdBy: product.createdBy,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        displayName: product.displayName,
        displayUnit: product.displayUnit,
      })),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (error) {
    console.error('Get products error:', error.message, error.stack);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', authMiddleware.auth, [
  check('name', 'Name is required').not().isEmpty(),
  check('code', 'Code is required').not().isEmpty(),
  check('department', 'Department is required').not().isEmpty(),
  check('price', 'Price is required and must be a number').isNumeric(),
  check('unit', 'Unit is required').not().isEmpty(),
], async (req, res) => {
  try {
    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    const departmentExists = await Department.findById(department);
    if (!departmentExists) {
      return res.status(400).json({ success: false, message: 'Invalid department ID' });
    }

    const existingProduct = await Product.findOne({ code });
    if (existingProduct) {
      return res.status(400).json({ success: false, message: 'Product code already exists' });
    }

    const product = new Product({
      name: name.trim(),
      nameEn: nameEn ? nameEn.trim() : undefined,
      code: code.trim(),
      department,
      price: parseFloat(price),
      unit,
      unitEn: unitEn || undefined,
      description: description ? description.trim() : undefined,
      createdBy: req.user._id,
    });

    await product.save();
    await product.populate('department', 'name nameEn code');

    res.status(201).json({
      success: true,
      data: {
        _id: product._id,
        name: product.name,
        nameEn: product.nameEn,
        code: product.code,
        department: product.department,
        price: product.price,
        unit: product.unit,
        unitEn: product.unitEn,
        description: product.description,
        image: product.image,
        ingredients: product.ingredients,
        preparationTime: product.preparationTime,
        isActive: product.isActive,
        createdBy: product.createdBy,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        displayName: product.displayName,
        displayUnit: product.displayUnit,
      },
    });
  } catch (error) {
    console.error('Create product error:', error.message, error.stack);
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/:id', authMiddleware.auth, [
  check('name', 'Name is required').not().isEmpty(),
  check('code', 'Code is required').not().isEmpty(),
  check('department', 'Department is required').not().isEmpty(),
  check('price', 'Price is required and must be a number').isNumeric(),
  check('unit', 'Unit is required').not().isEmpty(),
], async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    const departmentExists = await Department.findById(department);
    if (!departmentExists) {
      return res.status(400).json({ success: false, message: 'Invalid department ID' });
    }

    const existingProduct = await Product.findOne({ code, _id: { $ne: id } });
    if (existingProduct) {
      return res.status(400).json({ success: false, message: 'Product code already exists' });
    }

    const product = await Product.findByIdAndUpdate(
      id,
      {
        name: name.trim(),
        nameEn: nameEn ? nameEn.trim() : undefined,
        code: code.trim(),
        department,
        price: parseFloat(price),
        unit,
        unitEn: unitEn || undefined,
        description: description ? description.trim() : undefined,
        updatedAt: new Date(),
      },
      { new: true, runValidators: true }
    ).populate('department', 'name nameEn code');

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        _id: product._id,
        name: product.name,
        nameEn: product.nameEn,
        code: product.code,
        department: product.department,
        price: product.price,
        unit: product.unit,
        unitEn: product.unitEn,
        description: product.description,
        image: product.image,
        ingredients: product.ingredients,
        preparationTime: product.preparationTime,
        isActive: product.isActive,
        createdBy: product.createdBy,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        displayName: product.displayName,
        displayUnit: product.displayUnit,
      },
    });
  } catch (error) {
    console.error('Update product error:', error.message, error.stack);
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const product = await Product.findByIdAndUpdate(id, { isActive: false }, { new: true });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({ success: true, message: 'Product deactivated' });
  } catch (error) {
    console.error('Delete product error:', error.message, error.stack);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;