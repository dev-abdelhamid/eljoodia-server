const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Product = require('../models/Product');
const Department = require('../models/department');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { department, search, limit = 10, page = 1, isRtl } = req.query;
    const query = { isActive: true };
    
    if (department) {
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
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .setOptions({ context: { isRtl: isRtl === 'true' } });

    const total = await Product.countDocuments(query);
    
    res.status(200).json({
      data: products.map((product) => ({
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
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    if (!name || !code || !department || !price || !unit) {
      return res.status(400).json({ message: 'Name, code, department, price, and unit are required' });
    }

    const departmentExists = await Department.findById(department);
    if (!departmentExists) {
      return res.status(400).json({ message: 'Invalid department ID' });
    }

    const existingProduct = await Product.findOne({ code });
    if (existingProduct) {
      return res.status(400).json({ message: 'Product code already exists' });
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
      createdBy: req.user.id,
    });

    await product.save();
    await product.populate('department', '_id name nameEn code description');

    res.status(201).json({
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
    });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(400).json({ message: 'Error creating product', error: err.message });
  }
});

router.put('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    if (!name || !code || !department || !price || !unit) {
      return res.status(400).json({ message: 'Name, code, department, price, and unit are required' });
    }

    const departmentExists = await Department.findById(department);
    if (!departmentExists) {
      return res.status(400).json({ message: 'Invalid department ID' });
    }

    const existingProduct = await Product.findOne({ code, _id: { $ne: id } });
    if (existingProduct) {
      return res.status(400).json({ message: 'Product code already exists' });
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
      { new: true }
    ).populate('department', '_id name nameEn code description');

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.status(200).json({
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
    });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(400).json({ message: 'Error updating product', error: err.message });
  }
});

router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findByIdAndDelete(id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;