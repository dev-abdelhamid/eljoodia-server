const express = require('express');
const { body, param } = require('express-validator');
const {
  createOrder,
  getOrders,
  getOrderById,
  updateOrder,
  createReturn,
  approveReturn,
  assignChefs,
  approveOrder,
  cancelOrder,
  startTransit,
  confirmDelivery,
  confirmOrderReceipt,
  deleteOrder,
  checkOrderExists,
} = require('../controllers/orderController');
const {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
  deleteTask,
} = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'عدد كبير جدًا من طلبات تأكيد التسليم، حاول مرة أخرى لاحقًا',
  headers: true,
});

router.get('/:id/check', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], checkOrderExists);

router.post('/tasks', [
  auth,
  authorize('admin', 'production'),
  body('order').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('product').isMongoId().withMessage('معرف المنتج غير صالح'),
  body('chef').isMongoId().withMessage('معرف الشيف غير صالح'),
  body('quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون على الأقل 1'),
  body('itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
], createTask);

router.get('/tasks', auth, getTasks);

router.get('/tasks/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage('معرف الشيف غير صالح'),
], getChefTasks);

router.delete('/tasks/:taskId', [
  auth,
  authorize('admin'),
  param('taskId').isMongoId().withMessage('معرف المهمة غير صالح'),
], deleteTask);

router.post('/', [
  auth,
  authorize('branch'),
  body('items').isArray({ min: 1 }).withMessage('العناصر مطلوبة'),
  body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون على الأقل 1'),
], createOrder);

router.get('/', auth, getOrders);

router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], getOrderById);

router.patch('/:id', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('status').optional().isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة غير صالحة'),
  body('items').optional().isArray({ min: 1 }).withMessage('يجب أن تكون العناصر مصفوفة غير فارغة'),
  body('items.*.product').optional().isMongoId().withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').optional().isInt({ min: 1 }).withMessage('الكمية يجب أن تكون على الأقل 1'),
], updateOrder);

router.post('/returns', [
  auth,
  authorize('branch'),
  body('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('items').isArray({ min: 1 }).withMessage('العناصر مطلوبة'),
  body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
  body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون على الأقل 1'),
  body('items.*.reason').isIn(['defective', 'wrong_item', 'other']).withMessage('سبب الإرجاع غير صالح'),
], createReturn);

router.patch('/returns/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage('حالة الإرجاع غير صالحة'),
], approveReturn);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('items').isArray({ min: 1 }).withMessage('مصفوفة العناصر مطلوبة'),
  body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
  body('items.*.assignedTo').isMongoId().withMessage('معرف الشيف غير صالح'),
], assignChefs);

router.patch('/:id/approve', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], approveOrder);

router.patch('/:id/cancel', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], cancelOrder);

router.patch('/:id/start-transit', [
  auth,
  authorize('production'),
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], startTransit);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.patch('/:id/confirm-receipt', [
  auth,
  authorize('branch'),
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], confirmOrderReceipt);

router.delete('/:id', [
  auth,
  authorize('admin'),
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], deleteOrder);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  param('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
  param('taskId').isMongoId().withMessage('معرف المهمة غير صالح'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('حالة المهمة غير صالحة'),
], updateTaskStatus);

module.exports = router;