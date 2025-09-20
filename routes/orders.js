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
  checkOrderExists
} = require('../controllers/orderController');
const { 
  createTask, 
  getTasks, 
  getChefTasks, 
  updateTaskStatus 
} = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

/**
 * Rate limiter for confirming delivery to prevent abuse
 */
const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'طلبات تأكيد التوصيل كثيرة جدًا، حاول مرة أخرى لاحقًا',
  headers: true,
});

/**
 * Middleware to check if Socket.IO is initialized
 */
const checkSocketIO = (req, res, next) => {
  if (!req.app.get('io')) {
    console.error(`[${new Date().toISOString()}] Socket.IO not initialized`);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر: Socket.IO غير متوفر' });
  }
  next();
};

/**
 * @route GET /orders/:id/check
 * @desc Check if an order exists
 * @access Authenticated users
 */
router.get('/:id/check', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], checkOrderExists);

/**
 * @route POST /orders/tasks
 * @desc Create a new production task
 * @access Admin, Production
 */
router.post('/tasks', [
  auth,
  authorize('admin', 'production'),
  checkSocketIO,
  body('order').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('product').isMongoId().withMessage('معرف المنتج غير صالح'),
  body('chef').isMongoId().withMessage('معرف الشيف غير صالح'),
  body('quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون على الأقل 1'),
  body('itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
], createTask);

/**
 * @route GET /orders/tasks
 * @desc Get all production tasks
 * @access Authenticated users
 */
router.get('/tasks', auth, getTasks);

/**
 * @route GET /orders/tasks/chef/:chefId
 * @desc Get tasks assigned to a specific chef
 * @access Chef
 */
router.get('/tasks/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage('معرف الشيف غير صالح'),
], getChefTasks);

/**
 * @route POST /orders
 * @desc Create a new order
 * @access Branch
 */
router.post('/', [
  auth,
  authorize('branch'),
  checkSocketIO,
  body('orderNumber').notEmpty().withMessage('رقم الطلب مطلوب'),
  body('items').isArray({ min: 1 }).withMessage('مصفوفة العناصر مطلوبة ويجب أن تحتوي على عنصر واحد على الأقل'),
  body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون على الأقل 1'),
  body('branchId').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
  body('notes').optional().isString().trim().withMessage('الملاحظات يجب أن تكون نصًا'),
  body('priority').optional().isIn(['low', 'medium', 'high']).withMessage('الأولوية يجب أن تكون low, medium, أو high'),
], createOrder);

/**
 * @route GET /orders
 * @desc Get all orders
 * @access Authenticated users
 */
router.get('/', auth, getOrders);

/**
 * @route GET /orders/:id
 * @desc Get a specific order by ID
 * @access Authenticated users
 */
router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], getOrderById);

/**
 * @route PATCH /orders/:id/status
 * @desc Update order status
 * @access Admin, Production
 */
router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  checkSocketIO,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة غير صالحة'),
  body('notes').optional().isString().trim().withMessage('الملاحظات يجب أن تكون نصًا'),
], updateOrderStatus);

/**
 * @route PATCH /orders/:id/confirm-delivery
 * @desc Confirm order delivery
 * @access Branch
 */
router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  checkSocketIO,
  confirmDeliveryLimiter,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], confirmDelivery);

/**
 * @route PATCH /orders/returns/:id/status
 * @desc Approve or update return status
 * @access Admin, Production
 */
router.patch('/returns/:id/status', [
  auth,
  authorize('production', 'admin'),
  checkSocketIO,
  param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage('حالة الإرجاع غير صالحة'),
], approveReturn);

/**
 * @route PATCH /orders/:orderId/tasks/:taskId/status
 * @desc Update task status
 * @access Chef
 */
router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  checkSocketIO,
  param('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
  param('taskId').isMongoId().withMessage('معرف المهمة غير صالح'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('حالة المهمة غير صالحة'),
], updateTaskStatus);

/**
 * @route PATCH /orders/:id/assign
 * @desc Assign chefs to order items
 * @access Admin, Production
 */
router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  checkSocketIO,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('items').isArray({ min: 1 }).withMessage('مصفوفة العناصر مطلوبة ويجب أن تحتوي على عنصر واحد على الأقل'),
  body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
  body('items.*.assignedTo').isMongoId().withMessage('معرف الشيف المعين غير صالح'),
], assignChefs);

module.exports = router;