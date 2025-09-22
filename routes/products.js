const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Product = require('../models/Product');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { department, search, page = 1, limit = 10 } = req.query;
    const query = {};
    if (department) query.department = department;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const products = await Product.find(query)
      .populate('department', 'name _id')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    res.status(200).json(products);
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate('department', 'name _id');
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.status(200).json(product);
  } catch (err) {
    console.error('Get product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authMiddleware.auth, async (req, res) => {
  try {
    const { name, code, department, price, description, unit } = req.body;
    const product = new Product({
      name,
      code,
      department,
      price,
      description,
      unit: unit || 'piece',
      createdBy: req.user._id,
    });
    await product.save();
    await product.populate('department', 'name _id');
    res.status(201).json(product);
  } catch (err) {
    console.error('Create product error:', err);
    res.status(400).json({ message: 'Error creating product', error: err.message });
  }
});

router.put('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { name, code, department, price, description, unit } = req.body;
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    product.name = name || product.name;
    product.code = code || product.code;
    product.department = department || product.department; // Fixed typo: was 'dapartment'
    product.price = price || product.price;
    product.description = description || product.description;
    product.unit = unit || product.unit;
    await product.save();
    await product.populate('department', 'name _id');
    res.status(200).json(product);
  } catch (err) {
    console.error('Update product error:', err);
    res.status(400).json({ message: 'Error updating product', error: err.message });
  }
});

router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    await product.deleteOne();
    res.status(200).json({ message: 'Product deleted' });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;