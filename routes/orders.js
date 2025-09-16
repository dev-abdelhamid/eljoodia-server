const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  checkOrderExists,
  createOrder,
  getOrders,
  getOrderById,
} = require('../controllers/orderController');
const {
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
} = require('../controllers/statusController');

// Middleware to validate ObjectId
const validateObjectId = (field) =>
  param(field).custom((value) => mongoose.isValidObjectId(value)).withMessage(`معرف ${field} غير صالح`);

// Get all orders
router.get(
  '/',
  [auth, authorize('branch', 'admin', 'production')],
  getOrders
);

// Get order by ID
router.get(
  '/:id',
  [
    auth,
    authorize('branch', 'admin', 'production'),
    validateObjectId('id'),
  ],
  getOrderById
);

// Check if order exists
router.get(
  '/check/:id',
  [
    auth,
    authorize('branch', 'admin', 'production'),
    validateObjectId('id'),
  ],
  checkOrderExists
);

// Create a new order
router.post(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    body('orderNumber').notEmpty().withMessage('رقم الطلب مطلوب'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.product').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.price').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
    body('status').optional().isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة الطلب غير صالحة'),
    body('priority').optional().isIn(['low', 'medium', 'high']).withMessage('الأولوية غير صالحة'),
    body('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('notes').optional().trim(),
  ],
  createOrder
);

// Assign chefs to order items
router.post(
  '/:id/assign-chefs',
  [
    auth,
    authorize('admin', 'production'),
    validateObjectId('id'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف العنصر غير صالح'),
    body('items.*.assignedTo').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الشيف غير صالح'),
  ],
  assignChefs
);

// Approve an order
router.patch(
  '/:id/approve',
  [
    auth,
    authorize('admin', 'production'),
    validateObjectId('id'),
  ],
  approveOrder
);

// Start transit for an order
router.patch(
  '/:id/start-transit',
  [
    auth,
    authorize('production'),
    validateObjectId('id'),
  ],
  startTransit
);

// Confirm delivery of an order
router.patch(
  '/:id/confirm-delivery',
  [
    auth,
    authorize('branch'),
    validateObjectId('id'),
  ],
  confirmDelivery
);

// Update order status
router.patch(
  '/:id/status',
  [
    auth,
    authorize('admin', 'production', 'branch'),
    validateObjectId('id'),
    body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('حالة الطلب غير صالحة'),
  ],
  updateOrderStatus
);

// Confirm order receipt
router.patch(
  '/:id/confirm-receipt',
  [
    auth,
    authorize('branch'),
    validateObjectId('id'),
  ],
  confirmOrderReceipt
);

module.exports = router;