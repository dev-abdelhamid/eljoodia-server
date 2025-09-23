const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Product = require('../models/Product');
const Department = require('../models/department');

// Get all products with pagination and search
router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { page = 1, limit = 12, search = '', department = '' } = req.query;
    const isRtl = req.query.isRtl === 'true';
    const query = {};
    if (department) query.department = department;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { nameEn: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }
    query.isActive = true;
    const products = await Product.find(query)
      .populate({
        path: 'department',
        select: 'name nameEn _id',
        options: { context: { isRtl } },
      })
      .populate('createdBy', 'name _id')
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .setOptions({ context: { isRtl } });
    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / parseInt(limit));
    res.status(200).json({
      data: products,
      totalPages,
      currentPage: parseInt(page),
      totalItems: total,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get products error:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get single product by ID
router.get('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const product = await Product.findById(req.params.id)
      .populate({
        path: 'department',
        select: 'name nameEn _id',
        options: { context: { isRtl } },
      })
      .populate('createdBy', 'name _id')
      .setOptions({ context: { isRtl } });
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.status(200).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get product error:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Create a new product
router.post('/', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, unitEn, description, ingredients, preparationTime } = req.body;
    const isRtl = req.query.isRtl === 'true';
    // Validate required fields
    if (!name || !code || !department || !price || !unit) {
      return res.status(400).json({ message: 'Name, code, department, price, and unit are required' });
    }
    // Validate department
    const dept = await Department.findById(department).setOptions({ context: { isRtl } });
    if (!dept) {
      return res.status(400).json({ message: 'Invalid department ID' });
    }
    // Check for duplicate code
    const existingProduct = await Product.findOne({ code });
    if (existingProduct) {
      return res.status(400).json({ message: 'Product code already exists' });
    }
    const product = new Product({
      name,
      nameEn: nameEn || undefined,
      code,
      department,
      price: parseFloat(price),
      unit,
      unitEn: unitEn || undefined,
      description: description || undefined,
      ingredients: ingredients || [],
      preparationTime: preparationTime || 60,
      createdBy: req.user._id,
    });
    await product.save();
    await product.populate({
      path: 'department',
      select: 'name nameEn _id',
      options: { context: { isRtl } },
    });
    await product.populate('createdBy', 'name _id');
    res.status(201).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Create product error:`, err);
    res.status(400).json({ message: 'Error creating product', error: err.message });
  }
});

// Update a product
router.put('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, unitEn, description, ingredients, preparationTime } = req.body;
    const isRtl = req.query.isRtl === 'true';
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    // Validate department if provided
    if (department && department !== product.department.toString()) {
      const dept = await Department.findById(department).setOptions({ context: { isRtl } });
      if (!dept) {
        return res.status(400).json({ message: 'Invalid department ID' });
      }
    }
    // Check for duplicate code
    if (code && code !== product.code) {
      const existingProduct = await Product.findOne({ code });
      if (existingProduct) {
        return res.status(400).json({ message: 'Product code already exists' });
      }
    }
    product.name = name || product.name;
    product.nameEn = nameEn !== undefined ? nameEn : product.nameEn;
    product.code = code || product.code;
    product.department = department || product.department;
    product.price = price !== undefined ? parseFloat(price) : product.price;
    product.unit = unit || product.unit;
    product.unitEn = unitEn !== undefined ? unitEn : product.unitEn;
    product.description = description !== undefined ? description : product.description;
    product.ingredients = ingredients !== undefined ? ingredients : product.ingredients;
    product.preparationTime = preparationTime !== undefined ? preparationTime : product.preparationTime;
    await product.save();
    await product.populate({
      path: 'department',
      select: 'name nameEn _id',
      options: { context: { isRtl } },
    });
    await product.populate('createdBy', 'name _id');
    res.status(200).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Update product error:`, err);
    res.status(400).json({ message: 'Error updating product', error: err.message });
  }
});

// Delete a product
router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    await product.deleteOne();
    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Delete product error:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;