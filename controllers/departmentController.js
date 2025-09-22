const Department = require('../models/department');

exports.getDepartments = async (req, res) => {
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
    console.error('Get departments error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createDepartment = async (req, res) => {
  try {
    const { name, nameEn, code, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (!name || !code) {
      return res.status(400).json({ success: false, message: 'Name and code are required' });
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
    console.error('Create department error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, nameEn, code, description } = req.body;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (!name || !code) {
      return res.status(400).json({ success: false, message: 'Name and code are required' });
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
    );

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

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
    console.error('Update department error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteDepartment = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const department = await Department.findById(id);
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    // Check if department is used by any active products
    const productsInDepartment = await Product.find({ department: id, isActive: true });
    if (productsInDepartment.length > 0) {
      return res.status(400).json({ success: false, message: 'Cannot delete department with active products' });
    }

    await Department.findByIdAndUpdate(id, { isActive: false }, { new: true });

    res.status(200).json({ success: true, message: 'Department deactivated' });
  } catch (error) {
    console.error('Delete department error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};