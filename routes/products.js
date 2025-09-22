const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

router.get('/', async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { department, search } = req.query;
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
      .lean();

    const transformedProducts = products.map((product) => ({
      ...product,
      name: isRtl ? product.name : product.nameEn || product.name,
      department: product.department
        ? {
            ...product.department,
            name: isRtl
              ? product.department.name
              : product.department.nameEn || product.department.name,
          }
        : null,
    }));

    res.json(transformedProducts);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get products error:`, error.message, error.stack);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const productData = {
      ...req.body,
      name: req.body.name?.trim(),
      nameEn: req.body.nameEn?.trim(),
      code: req.body.code?.trim(),
      description: req.body.description?.trim(),
      ingredients: req.body.ingredients?.map((ing) => ing.trim()),
    };

    const product = new Product(productData);
    await product.save();

    const populatedProduct = await Product.findById(product._id)
      .populate('department', 'name nameEn code')
      .lean();

    res.status(201).json({
      ...populatedProduct,
      name: isRtl ? populatedProduct.name : populatedProduct.nameEn || populatedProduct.name,
      department: populatedProduct.department
        ? {
            ...populatedProduct.department,
            name: isRtl
              ? populatedProduct.department.name
              : populatedProduct.department.nameEn || populatedProduct.department.name,
          }
        : null,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Create product error:`, error.message, error.stack);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'رمز المنتج مستخدم بالفعل' });
    }
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'معرف المنتج غير صالح' });
    }

    const productData = {
      ...req.body,
      name: req.body.name?.trim(),
      nameEn: req.body.nameEn?.trim(),
      code: req.body.code?.trim(),
      description: req.body.description?.trim(),
      ingredients: req.body.ingredients?.map((ing) => ing.trim()),
    };

    const product = await Product.findByIdAndUpdate(req.params.id, productData, { new: true })
      .populate('department', 'name nameEn code')
      .lean();

    if (!product) {
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    res.json({
      ...product,
      name: isRtl ? product.name : product.nameEn || product.name,
      department: product.department
        ? {
            ...product.department,
            name: isRtl
              ? product.department.name
              : product.department.nameEn || product.department.name,
          }
        : null,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Update product error:`, error.message, error.stack);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'رمز المنتج مستخدم بالفعل' });
    }
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'معرف المنتج غير صالح' });
    }

    const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!product) {
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    res.json({ success: true, message: 'تم تعطيل المنتج بنجاح' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Delete product error:`, error.message, error.stack);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: error.message });
  }
});

module.exports = router;