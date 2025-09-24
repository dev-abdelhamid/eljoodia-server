const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Product = require('../models/Product');
const Department = require('../models/department');

// Get all products with pagination and search
router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { page = 1, limit = 12, search = '', department = '', lang = 'ar', quantity = 1 } = req.query;
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
      .setOptions({ context: { isRtl: lang === 'ar', quantity: parseInt(quantity) } })
      .populate('department', 'name nameEn _id')
      .populate('createdBy', 'name _id')
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / parseInt(limit));

    res.status(200).json({
      data: products,
      totalPages,
      currentPage: parseInt(page),
      totalItems: total
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get products error:`, err);
    res.status(500).json({ message: 'خطأ في الخادم', error: err.message });
  }
});

// Get single product by ID
router.get('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { lang = 'ar', quantity = 1 } = req.query;
    const product = await Product.findById(req.params.id)
      .setOptions({ context: { isRtl: lang === 'ar', quantity: parseInt(quantity) } })
      .populate('department', 'name nameEn _id')
      .populate('createdBy', 'name _id');
    if (!product) {
      return res.status(404).json({ message: 'المنتج غير موجود' });
    }
    res.status(200).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get product error:`, err);
    res.status(500).json({ message: 'خطأ في الخادم', error: err.message });
  }
});

// Create a new product
router.post('/', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, description, ingredients, preparationTime } = req.body;

    // Validate required fields
    if (!name || !code || !department || !price || !unit) {
      return res.status(400).json({ message: 'الاسم، الرمز، القسم، السعر، والوحدة مطلوبة' });
    }

    // Validate department
    const dept = await Department.findById(department);
    if (!dept) {
      return res.status(400).json({ message: 'معرف القسم غير صالح' });
    }

    // Check for duplicate code
    const existingProduct = await Product.findOne({ code });
    if (existingProduct) {
      return res.status(400).json({ message: 'رمز المنتج موجود بالفعل' });
    }

    // Validate unit
    const validUnits = ['كيلو', 'قطعة', 'علبة', 'صينية'];
    if (!validUnits.includes(unit)) {
      return res.status(400).json({ message: 'وحدة القياس غير صالحة' });
    }

    const product = new Product({
      name,
      nameEn: nameEn || undefined,
      code,
      department,
      price: parseFloat(price),
      unit,
      description: description || undefined,
      ingredients: ingredients || [],
      preparationTime: preparationTime || 60,
      createdBy: req.user._id,
    });

    await product.save();
    await product.populate('department', 'name nameEn _id');
    await product.populate('createdBy', 'name _id');
    res.status(201).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Create product error:`, err);
    res.status(400).json({ message: 'خطأ في إنشاء المنتج', error: err.message });
  }
});

// Update a product
router.put('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, description, ingredients, preparationTime } = req.body;
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'المنتج غير موجود' });
    }

    // Validate required fields
    if (name !== undefined && !name) {
      return res.status(400).json({ message: 'الاسم مطلوب' });
    }
    if (code !== undefined && !code) {
      return res.status(400).json({ message: 'الرمز مطلوب' });
    }
    if (price !== undefined && (isNaN(price) || price < 0)) {
      return res.status(400).json({ message: 'السعر يجب أن يكون رقمًا غير سالب' });
    }
    if (unit !== undefined && !['كيلو', 'قطعة', 'علبة', 'صينية'].includes(unit)) {
      return res.status(400).json({ message: 'وحدة القياس غير صالحة' });
    }

    // Validate department if provided
    if (department && department !== product.department.toString()) {
      const dept = await Department.findById(department);
      if (!dept) {
        return res.status(400).json({ message: 'معرف القسم غير صالح' });
      }
    }

    // Check for duplicate code
    if (code && code !== product.code) {
      const existingProduct = await Product.findOne({ code });
      if (existingProduct) {
        return res.status(400).json({ message: 'رمز المنتج موجود بالفعل' });
      }
    }

    // Update fields only if provided
    if (name !== undefined) product.name = name;
    if (nameEn !== undefined) product.nameEn = nameEn;
    if (code !== undefined) product.code = code;
    if (department !== undefined) product.department = department;
    if (price !== undefined) product.price = parseFloat(price);
    if (unit !== undefined) product.unit = unit;
    if (description !== undefined) product.description = description;
    if (ingredients !== undefined) product.ingredients = ingredients;
    if (preparationTime !== undefined) product.preparationTime = preparationTime;

    await product.save();
    await product.populate('department', 'name nameEn _id');
    await product.populate('createdBy', 'name _id');
    res.status(200).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Update product error:`, err);
    res.status(400).json({ message: 'خطأ في تحديث المنتج', error: err.message });
  }
});

// Delete a product
router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'المنتج غير موجود' });
    }
    await product.deleteOne();
    res.status(200).json({ message: 'تم حذف المنتج بنجاح' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Delete product error:`, err);
    res.status(500).json({ message: 'خطأ في الخادم', error: err.message });
  }
});

module.exports = router;