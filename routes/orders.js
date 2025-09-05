const express = require('express');
const router = express.Router();
const {
  checkOrderExists,
  createOrder,
  getOrders,
  getOrderById,
  createReturn,
  approveReturn,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
} = require('../controllers/orderController');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Middleware للتحقق من التوكن وتفاصيل المستخدم
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : null;

  if (!token) {
    console.error(`[${new Date().toISOString()}] No token provided for request: ${req.method} ${req.url}`);
    return res.status(401).json({ success: false, message: 'التوكن مطلوب' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded.id)
      .populate('branch', 'name _id')
      .populate('department', 'name _id')
      .lean();
    if (!user) {
      console.error(`[${new Date().toISOString()}] User not found for token: ${decoded.id}`);
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    req.user = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      branchId: user.branch?._id?.toString() || null,
      departmentId: user.department?._id?.toString() || null,
    };
    console.log(`[${new Date().toISOString()}] Authenticated user: ${req.user.username}, Role: ${req.user.role}, Request: ${req.method} ${req.url}`);
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Token verification failed: ${err.message}`);
    return res.status(403).json({ success: false, message: 'التوكن غير صالح', error: err.message });
  }
};

// Middleware للتحقق من صلاحيات الدور
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      console.error(`[${new Date().toISOString()}] Unauthorized access attempt:`, {
        userId: req.user.id,
        role: req.user.role,
        requiredRoles: roles,
        request: `${req.method} ${req.url}`,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الإجراء' });
    }
    next();
  };
};

// Middleware للتحقق من صلاحيات الفرع
const restrictToBranch = (req, res, next) => {
  if (req.user.role === 'branch' && req.params.id) {
    Order.findById(req.params.id)
      .lean()
      .then(order => {
        if (!order) {
          console.error(`[${new Date().toISOString()}] Order not found for branch check: ${req.params.id}`);
          return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
        }
        if (order.branch?.toString() !== req.user.branchId) {
          console.error(`[${new Date().toISOString()}] Branch mismatch:`, {
            userBranch: req.user.branchId,
            orderBranch: order.branch,
            userId: req.user.id,
          });
          return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
        }
        next();
      })
      .catch(err => {
        console.error(`[${new Date().toISOString()}] Error checking branch: ${err.message}`);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
      });
  } else {
    next();
  }
};

// التحقق من وجود الطلب
router.get('/:id/exists', authenticateToken, checkOrderExists);

// إنشاء طلب جديد
router.post('/', authenticateToken, restrictTo('admin', 'branch'), createOrder);

// استرجاع جميع الطلبات
router.get('/', authenticateToken, restrictTo('admin', 'production', 'branch'), getOrders);

// استرجاع طلب معين
router.get('/:id', authenticateToken, restrictTo('admin', 'production', 'branch'), restrictToBranch, getOrderById);

// إنشاء طلب إرجاع
router.post('/:id/return', authenticateToken, restrictTo('branch'), restrictToBranch, createReturn);

// الموافقة على طلب إرجاع
router.patch('/:id/return/:returnId', authenticateToken, restrictTo('admin', 'production'), approveReturn);

// تعيين الشيفات للطلب
router.post('/:id/assign-chefs', authenticateToken, restrictTo('admin', 'production'), assignChefs);

// الموافقة على الطلب
router.patch('/:id/approve', authenticateToken, restrictTo('admin', 'production'), approveOrder);

// بدء الشحن
router.patch('/:id/start-transit', authenticateToken, restrictTo('production'), startTransit);

// تأكيد التسليم
router.patch('/:id/confirm-delivery', authenticateToken, restrictTo('branch'), restrictToBranch, confirmDelivery);

// تحديث حالة الطلب
router.patch('/:id/status', authenticateToken, restrictTo('admin', 'production', 'branch'), restrictToBranch, updateOrderStatus);

// تأكيد استلام الطلب
router.patch('/:id/confirm-receipt', authenticateToken, restrictTo('branch'), restrictToBranch, confirmOrderReceipt);

module.exports = router;