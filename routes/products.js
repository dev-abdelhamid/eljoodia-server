const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
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
      .populate('department', '_id name nameEn code description')
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .setOptions({ context: { isRtl: isRtl === 'true' } });

    const total = await Product.countDocuments(query);

    console.log(`[${new Date().toISOString()}] Products fetched:`, products);

    res.status(200).json({
      success: true,
      data: products.map(product => ({
        _id: product._id,
        name: product.name,
        nameEn: product.nameEn,
        code: product.code,
        department: {
          _id: product.department._id,
          name: product.department.name,
          nameEn: product.department.nameEn,
          code: product.department.code,
          description: product.department.description,
          displayName: product.department.displayName || (isRtl === 'true' ? product.department.name : product.department.nameEn || product.department.name),
        },
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
        displayName: product.displayName || (isRtl === 'true' ? product.name : product.nameEn || product.name),
        displayUnit: product.displayUnit || (isRtl === 'true' ? product.unit : product.unitEn || product.unit),
      })),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get products error:`, error);
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

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
    await product.populate('department', '_id name nameEn code description');

    console.log(`[${new Date().toISOString()}] Product created:`, product);

    res.status(201).json({
      success: true,
      data: {
        _id: product._id,
        name: product.name,
        nameEn: product.nameEn,
        code: product.code,
        department: {
          _id: product.department._id,
          name: product.department.name,
          nameEn: product.department.nameEn,
          code: product.department.code,
          description: product.department.description,
          displayName: product.department.displayName || (req.query.isRtl === 'true' ? product.department.name : product.department.nameEn || product.department.name),
        },
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
        displayName: product.displayName || (req.query.isRtl === 'true' ? product.name : product.nameEn || product.name),
        displayUnit: product.displayUnit || (req.query.isRtl === 'true' ? product.unit : product.unitEn || product.unit),
      },
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Create product error:`, error);
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
    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

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
    ).populate('department', '_id name nameEn code description')
      .setOptions({ context: { isRtl: req.query.isRtl === 'true' } });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    console.log(`[${new Date().toISOString()}] Product updated:`, product);

    res.status(200).json({
      success: true,
      data: {
        _id: product._id,
        name: product.name,
        nameEn: product.nameEn,
        code: product.code,
        department: {
          _id: product.department._id,
          name: product.department.name,
          nameEn: product.department.nameEn,
          code: product.department.code,
          description: product.department.description,
          displayName: product.department.displayName || (req.query.isRtl === 'true' ? product.department.name : product.department.nameEn || product.department.name),
        },
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
        displayName: product.displayName || (req.query.isRtl === 'true' ? product.name : product.nameEn || product.name),
        displayUnit: product.displayUnit || (req.query.isRtl === 'true' ? product.unit : product.unitEn || product.unit),
      },
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Update product error:`, error);
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

    console.log(`[${new Date().toISOString()}] Product deactivated:`, id);

    res.status(200).json({ success: true, message: 'Product deactivated' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Delete product error:`, error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;