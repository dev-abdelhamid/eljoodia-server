// middleware/auth.js
const jwt = require('jsonwebtoken');
require('dotenv').config();

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, message: 'التوثيق مطلوب' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET);
    const user = await require('../models/User').findById(decoded.id).lean();
    if (!user) {
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    req.user = {
      id: user._id,
      username: user.username,
      role: user.role,
      branchId: user.branch ? user.branch.toString() : null,
      permissions: user.permissions || [],
    };
    console.log(`Auth middleware - req.user at ${new Date().toISOString()}:`, req.user);
    next();
  } catch (error) {
    console.error(`Auth middleware error at ${new Date().toISOString()}:`, error);
    res.status(401).json({ success: false, message: 'التوكن غير صالح أو منتهي الصلاحية' });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
    }
    next();
  };
};

module.exports = { auth, authorize };