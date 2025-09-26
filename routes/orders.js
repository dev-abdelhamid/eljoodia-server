const express = require('express');
const { body, param, query } = require('express-validator');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  approveReturn,
  getOrderById,
  checkOrderExists,
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
  message: { en: 'Too many requests to confirm delivery, please try again later', ar: 'طلبات تأكيد التوصيل كثيرة جدًا، حاول مرة أخرى لاحقًا' },
  headers: true,
});

const approveReturnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { en: 'Too many requests to approve returns, please try again later', ar: 'طلبات اعتماد المرتجعات كثيرة جدًا، حاول مرة أخرى لاحقًا' },
  headers: true,
});

router.get('/:id/check', [
  auth,
  param('id').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], checkOrderExists);

router.post('/tasks', [
  auth,
  authorize('admin', 'production'),
  body('order').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  body('product').isMongoId().withMessage({ en: 'Invalid product ID', ar: 'معرف المنتج غير صالح' }),
  body('chef').isMongoId().withMessage({ en: 'Invalid chef ID', ar: 'معرف الشيف غير صالح' }),
  body('quantity').isInt({ min: 1 }).withMessage({ en: 'Quantity must be at least 1', ar: 'الكمية يجب أن تكون 1 على الأقل' }),
  body('itemId').isMongoId().withMessage({ en: 'Invalid itemId', ar: 'معرف العنصر غير صالح' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], createTask);

router.get('/tasks', [
  auth,
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], getTasks);

router.get('/tasks/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage({ en: 'Invalid chef ID', ar: 'معرف الشيف غير صالح' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], getChefTasks);

router.post('/', [
  auth,
  authorize('branch'),
  body('orderNumber').notEmpty().withMessage({ en: 'Order number is required', ar: 'رقم الطلب مطلوب' }),
  body('branchId').optional().isMongoId().withMessage({ en: 'Invalid branch ID', ar: 'معرف الفرع غير صالح' }),
  body('items').isArray({ min: 1 }).withMessage({ en: 'Items are required', ar: 'العناصر مطلوبة' }),
  body('items.*.product').isMongoId().withMessage({ en: 'Invalid product ID', ar: 'معرف المنتج غير صالح' }),
  body('items.*.quantity').isInt({ min: 1 }).withMessage({ en: 'Quantity must be a positive integer', ar: 'الكمية يجب أن تكون عددًا صحيحًا إيجابيًا' }),
  body('items.*.price').isFloat({ min: 0 }).withMessage({ en: 'Price must be a positive number', ar: 'السعر يجب أن يكون رقمًا إيجابيًا' }),
  body('items.*.returnReason').optional().isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى', '']).withMessage({ en: 'Invalid return reason', ar: 'سبب الإرجاع غير صالح' }),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage({ en: 'Invalid priority', ar: 'أولوية غير صالحة' }),
  body('notes').optional().trim(),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], createOrder);

router.get('/', [
  auth,
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], getOrders);

router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], getOrderById);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage({ en: 'Invalid status', ar: 'حالة غير صالحة' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], updateOrderStatus);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  param('id').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  confirmDeliveryLimiter,
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], confirmDelivery);

router.patch('/returns/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage({ en: 'Invalid return ID', ar: 'معرف المرتجع غير صالح' }),
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage({ en: 'Invalid return status', ar: 'حالة المرتجع غير صالحة' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], approveReturn);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  param('orderId').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  param('taskId').isMongoId().withMessage({ en: 'Invalid task ID', ar: 'معرف المهمة غير صالح' }),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage({ en: 'Invalid task status', ar: 'حالة المهمة غير صالحة' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], updateTaskStatus);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  body('items').isArray({ min: 1 }).withMessage({ en: 'Items array is required', ar: 'مصفوفة العناصر مطلوبة' }),
  body('items.*.itemId').isMongoId().withMessage({ en: 'Invalid itemId', ar: 'معرف العنصر غير صالح' }),
  body('items.*.assignedTo').isMongoId().withMessage({ en: 'Invalid assignedTo', ar: 'معرف المعين غير صالح' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], assignChefs);

module.exports = router;