const express = require('express');
const { body, param, query } = require('express-validator');
const {
  createOrderWithTasks,
  getOrders,
  getOrderById,
  approveOrder,
  startTransit,
  updateOrderStatus,
  confirmDelivery,
  approveReturn,
  getTasks,
  getChefTasks,
  updateTaskStatus,
} = require('../controllers/orderController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate Limiting for sensitive routes
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'عدد الطلبات تجاوز الحد المسموح، يرجى المحاولة لاحقًا',
  standardHeaders: true,
  legacyHeaders: false,
});

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'عدد طلبات تأكيد التسليم تجاوز الحد المسموح، يرجى المحاولة لاحقًا',
  standardHeaders: true,
  legacyHeaders: false,
});

// Request logging
router.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - User: ${req.user?.id || 'unknown'}`);
  next();
});

// Create order
router.post(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    orderLimiter,
    body('orderNumber').notEmpty().withMessage('رقم الطلب مطلوب'),
    body('items').isArray({ min: 1 }).withMessage('يجب إدخال عنصر واحد على الأقل'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
    body('items.*.price').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا إيجابيًا'),
    body('tasks').optional().isArray().withMessage('المهام يجب أن تكون مصفوفة'),
    body('tasks.*.product').optional().isMongoId().withMessage('معرف المنتج في المهام غير صالح'),
    body('tasks.*.chef').optional().isMongoId().withMessage('معرف الشيف في المهام غير صالح'),
    body('tasks.*.quantity').optional().isInt({ min: 1 }).withMessage('كمية المهمة يجب أن تكون أكبر من 0'),
    body('tasks.*.itemId').optional().isMongoId().withMessage('معرف العنصر في المهام غير صالح'),
    body('status').optional().isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة الطلب غير صالحة'),
    body('priority').optional().isIn(['low', 'medium', 'high']).withMessage('الأولوية غير صالحة'),
  ],
  createOrderWithTasks
);

// Get all orders
router.get(
  '/',
  [auth, query('status').optional().isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة الطلب غير صالحة')],
  getOrders
);

// Get specific order
router.get(
  '/:id',
  [
    auth,
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  ],
  getOrderById
);

// Approve order
router.put(
  '/:id/approve',
  [
    auth,
    authorize('admin', 'production'),
    orderLimiter,
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  ],
  approveOrder
);

// Start transit
router.put(
  '/:id/transit',
  [
    auth,
    authorize('production'),
    orderLimiter,
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  ],
  startTransit
);

// Update order status
router.put(
  '/:id/status',
  [
    auth,
    authorize('production', 'admin'),
    orderLimiter,
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة الطلب غير صالحة'),
    body('notes').optional().isString().trim().withMessage('الملاحظات يجب أن تكون نصًا'),
  ],
  updateOrderStatus
);

// Confirm delivery
router.put(
  '/:id/delivery',
  [
    auth,
    authorize('branch'),
    confirmDeliveryLimiter,
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  ],
  confirmDelivery
);

// Approve return
router.put(
  '/return/:id',
  [
    auth,
    authorize('production', 'admin'),
    orderLimiter,
    param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
    body('status').isIn(['approved', 'rejected']).withMessage('حالة الإرجاع غير صالحة'),
    body('reviewNotes').optional().isString().trim().withMessage('ملاحظات المراجعة يجب أن تكون نصًا'),
  ],
  approveReturn
);

// Get tasks
router.get(
  '/tasks',
  [
    auth,
    authorize('production', 'admin'),
    query('orderId').optional().isMongoId().withMessage('معرف الطلب غير صالح'),
    query('status').optional().isIn(['pending', 'assigned', 'in_progress', 'completed']).withMessage('حالة المهمة غير صالحة'),
    query('departmentId').optional().isMongoId().withMessage('معرف القسم غير صالح'),
  ],
  getTasks
);

// Get chef tasks
router.get(
  '/chef-tasks',
  [
    auth,
    authorize('chef'),
    query('status').optional().isIn(['pending', 'in_progress', 'completed']).withMessage('حالة المهمة غير صالحة'),
  ],
  getChefTasks
);

// Update task status
router.put(
  '/tasks/:id/status',
  [
    auth,
    authorize('chef'),
    param('id').isMongoId().withMessage('معرف المهمة غير صالح'),
    body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('حالة المهمة غير صالحة'),
  ],
  updateTaskStatus
);

export default router;