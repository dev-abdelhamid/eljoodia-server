const Product = require('../models/Product');
const Department = require('../models/department');

exports.getProducts = async (req, res) => {
  try {
    const { department, search, limit = 10, page = 1, isRtl = 'true' } = req.query;
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
      success: true,
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
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createProduct = async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (!name || !code || !department || !price || !unit) {
      return res.status(400).json({ success: false, message: 'Name, code, department, price, and unit are required' });
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
    console.error('Create product error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, nameEn, code, department, price, unit, unitEn, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (!name || !code || !department || !price || !unit) {
      return res.status(400).json({ success: false, message: 'Name, code, department, price, and unit are required' });
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
    ).populate('department', '_id name nameEn code description');

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
    console.error('Update product error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const product = await Product.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({ success: true, message: 'Product deactivated' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};