// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
require('dotenv').config();

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    console.error(`No token provided in request at ${new Date().toISOString()}`);
    return res.status(401).json({ success: false, message: 'التوثيق مطلوب' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id)
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();
    if (!user) {
      console.error(`User not found for token at ${new Date().toISOString()}:`, decoded.id);
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    req.user = {
      id: user._id,
      username: user.username,
      role: user.role,
      branchId: user.branch ? user.branch.toString() : null,
      branchName: user.branch?.name,
      departmentId: user.department ? user.department.toString() : null,
      departmentName: user.department?.name,
      permissions: user.permissions || getPermissions(user.role),
    };
    console.log(`Auth middleware - req.user at ${new Date().toISOString()}:`, req.user);
    next();
  } catch (error) {
    console.error(`Auth middleware error at ${new Date().toISOString()}:`, error.message);
    res.status(401).json({ success: false, message: 'التوكن غير صالح أو منتهي الصلاحية', error: error.message });
  }
};

const getPermissions = (role) => {
  switch (role) {
    case 'admin':
      return ['manage_users', 'manage_branches', 'manage_products', 'view_reports', 'manage_orders'];
    case 'production':
      return ['manage_orders', 'view_reports'];
    case 'branch':
      return ['create_orders', 'view_branch_orders', 'manage_inventory'];
    case 'chef':
      return ['update_order_items', 'view_assigned_orders'];
    default:
      return [];
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      console.error(`Unauthorized access attempt at ${new Date().toISOString()}:`, { user: req.user, roles });
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }
    next();
  };
};

module.exports = { auth, authorize };