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
  confirmOrderReceipt
} = require('../controllers/orderController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
  headers: true,
});

router.get('/:id/check', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], checkOrderExists);

router.post('/', [
  auth,
  authorize('branch'),
  body('items').isArray({ min: 1 }).withMessage('العناصر مطلوبة'),
], createOrder);

router.get('/', auth, getOrders);

router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], getOrderById);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة غير صالحة'),
], updateOrderStatus);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.patch('/:id/confirm-receipt', [
  auth,
  authorize('branch'),
  param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
], confirmOrderReceipt);

router.patch('/returns/:id/status', [
  auth,
  authorize('production', 'admin'),
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage('حالة الإرجاع غير صالحة'),
], approveReturn);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  body('items').isArray({ min: 1 }).withMessage('مصفوفة العناصر مطلوبة'),
  body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
  body('items.*.assignedTo').isMongoId().withMessage('معرف الشيف غير صالح'),
], assignChefs);

module.exports = router;