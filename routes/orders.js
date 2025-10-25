const express = require('express');
const { body, param, query } = require('express-validator');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  getOrderById,
  checkOrderExists,
  confirmOrderReceipt, // إضافة دالة تأكيد الاستلام
} = require('../controllers/orderController');
const {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
} = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
  headers: true,
});

const confirmReceiptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm receipt, please try again later',
  headers: true,
});

// التحقق من وجود الطلب
router.get(
  '/:id/check',
  [
    auth,
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  checkOrderExists
);

// إنشاء مهمة إنتاج
router.post(
  '/tasks',
  [
    auth,
    authorize('admin', 'production'),
    body('order').isMongoId().withMessage('Invalid order ID'),
    body('product').isMongoId().withMessage('Invalid product ID'),
    body('chef').isMongoId().withMessage('Invalid chef ID'),
    body('items.*.quantity').isFloat({ min: 0.5 }).withMessage('Quantity must be at least 0.5'),
    body('itemId').isMongoId().withMessage('Invalid itemId'),
  ],
  createTask
);

router.post('/tasks', [
  auth,
  authorize('admin', 'production'),
  body('order').isMongoId().withMessage('Invalid order ID'),
  body('product').isMongoId().withMessage('Invalid product ID'),
  body('chef').isMongoId().withMessage('Invalid chef ID'),
  body('quantity').isInt({ min: 0 }).withMessage('Quantity must be at least 1'),
  body('itemId').isMongoId().withMessage('Invalid itemId'),
], createTask);

router.get('/tasks', auth, getTasks);
// جلب مهام الشيف
router.get('/tasks/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage('Invalid chef ID'),
], getChefTasks);

// إنشاء طلب جديد
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('items').isArray({ min: 1 }).withMessage('Items are required'),
    body('items.*.product').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isFloat({ min: 0.5 }).withMessage('Quantity must be at least 0.5'),
    body('items.*.unit').isIn(['كيلو', 'قطعة', 'علبة', 'صينية']).withMessage('Invalid unit'),
    body('items.*.unitEn').isIn(['Kilo', 'Piece', 'Pack', 'Tray']).withMessage('Invalid English unit'),
    body('notes').optional().isString().trim().notEmpty().withMessage('Notes cannot be empty if provided'),
    body('notesEn').optional().isString().trim().notEmpty().withMessage('English notes cannot be empty if provided'),
  ],
  createOrder
);

// جلب جميع الطلبات
router.get('/', auth, getOrders);

// جلب طلب محدد
router.get(
  '/:id',
  [
    auth,
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  getOrderById
);

// تحديث حالة الطلب
router.patch(
  '/:id/status',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('status')
      .isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'])
      .withMessage('Invalid status'),
  ],
  updateOrderStatus
);

// تأكيد تسليم الطلب
router.patch(
  '/:id/confirm-delivery',
  [
    auth,
    authorize('branch'),
    confirmDeliveryLimiter,
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  confirmDelivery
);

// تأكيد استلام الطلب مع دعم النواقص والملاحظات
router.patch(
  '/:id/confirm-receipt',
  [
    auth,
    authorize('branch'),
    confirmReceiptLimiter,
    param('id').isMongoId().withMessage('Invalid order ID'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
    body('notes').optional().isString().trim().notEmpty().withMessage('Notes cannot be empty if provided'),
    body('notesEn').optional().isString().trim().notEmpty().withMessage('English notes cannot be empty if provided'),
    body('shortages')
      .optional()
      .isArray()
      .withMessage('Shortages must be an array'),
    body('shortages.*.itemId').isMongoId().withMessage('Invalid itemId in shortages'),
    body('shortages.*.quantity').isFloat({ min: 0.5 }).withMessage('Shortage quantity must be at least 0.5'),
    body('shortages.*.reason').optional().isString().trim().notEmpty().withMessage('Shortage reason cannot be empty if provided'),
    body('shortages.*.reasonEn').optional().isString().trim().notEmpty().withMessage('Shortage reason in English cannot be empty if provided'),
  ],
  confirmOrderReceipt
);

// تحديث حالة مهمة الشيف
router.patch(
  '/:orderId/tasks/:taskId/status',
  [
    auth,
    authorize('chef'),
    param('orderId').isMongoId().withMessage('Invalid order ID'),
    param('taskId').isMongoId().withMessage('Invalid task ID'),
    body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
  ],
  updateTaskStatus
);

// تعيين الشيفات
router.patch(
  '/:id/assign',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('items').isArray({ min: 1 }).withMessage('Items array is required'),
    body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
    body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
  ],
  assignChefs
);

module.exports = router;