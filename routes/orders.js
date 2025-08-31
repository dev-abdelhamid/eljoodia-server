const express = require('express');
const { body, param } = require('express-validator');
const { 
  createOrder, 
  getOrders, 
  updateOrderStatus, 
  assignChefs,
  confirmDelivery,
  approveReturn,
  getOrderById,
  checkOrderExists,
  createReturn
} = require('../controllers/orderController');
const { 
  createTask, 
  getTasks, 
  getChefTasks, 
  updateTaskStatus 
} = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const Return = require('../models/Return');
const Order = require('../models/Order');
const mongoose = require('mongoose');

const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
  headers: true,
});

// جلب جميع طلبات الإرجاع
router.get(
  '/returns',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    param('id').optional().isMongoId().withMessage('Invalid return ID'),
  ],
  async (req, res) => {
    try {
      console.log(`[${new Date().toISOString()}] User accessing /api/returns:`, { userId: req.user.id, role: req.user.role });
      const { status, branch, page = 1, limit = 10 } = req.query;
      const query = {};
      if (status) query.status = status;
      if (branch && mongoose.isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch')
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .populate('createdBy', 'username')
        .populate('reviewedBy', 'username')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const formattedReturns = returns.map(ret => ({
        ...ret,
        createdAt: new Date(ret.createdAt).toISOString(),
        reviewedAt: ret.reviewedAt ? new Date(ret.reviewedAt).toISOString() : null,
        statusHistory: ret.statusHistory?.map(history => ({
          ...history,
          changedAt: new Date(history.changedAt).toISOString(),
        })),
      }));

      const total = await Return.countDocuments(query);

      console.log(`[${new Date().toISOString()}] Fetched ${returns.length} returns, total: ${total}`);
      res.status(200).json({ returns: formattedReturns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns:`, { error: err.message, userId: req.user.id });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// إنشاء طلب إرجاع
router.post(
  '/returns',
  [
    auth,
    authorize('branch'),
    body('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').isIn(['defective', 'wrong_item', 'other']).withMessage('سبب الإرجاع غير صالح'),
    body('notes').optional().trim(),
  ],
  createReturn
);

// الموافقة على طلب إرجاع
router.patch(
  '/returns/:id/status',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون "approved" أو "rejected"'),
    body('items.*.reviewNotes').optional().trim(),
  ],
  approveReturn
);

// باقي المسارات بدون تغيير
router.get('/:id/check', [
  auth,
  param('id').isMongoId().withMessage('Invalid order ID'),
], checkOrderExists);

router.post('/tasks', [
  auth,
  authorize('admin', 'production'),
  body('order').isMongoId().withMessage('Invalid order ID'),
  body('product').isMongoId().withMessage('Invalid product ID'),
  body('chef').isMongoId().withMessage('Invalid chef ID'),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('itemId').isMongoId().withMessage('Invalid itemId'),
], createTask);

router.get('/tasks', auth, getTasks);

router.get('/tasks/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage('Invalid chef ID'),
], getChefTasks);

router.post('/', [
  auth,
  authorize('branch'),
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
], createOrder);

router.get('/', auth, getOrders);

router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage('Invalid order ID'),
], getOrderById);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
], updateOrderStatus);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
], assignChefs);

module.exports = router;