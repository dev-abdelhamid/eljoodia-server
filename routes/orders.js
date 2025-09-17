const express = require('express');
const { body } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  createOrder,
  getOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
  assignChef,
  updateItemStatus,
  confirmDelivery,
  confirmOrderReceipt,
} = require('../controllers/statusController');

const router = express.Router();

// Create order
router.post('/', [
  auth,
  authorize('branch', 'admin'),
  body('branch').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي الطلبية على عنصر واحد على الأقل'),
  body('items.*.product').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
  body('items.*.price').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون عددًا غير سالب'),
], createOrder);

// Get all orders
router.get('/', auth, getOrders);

// Get order by ID
router.get('/:id', auth, getOrderById);

// Update order
router.put('/:id', [
  auth,
  authorize('branch', 'admin'),
  body('items').optional().isArray({ min: 1 }).withMessage('يجب أن تحتوي الطلبية على عنصر واحد على الأقل'),
  body('items.*.product').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').optional().isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
  body('items.*.price').optional().isFloat({ min: 0 }).withMessage('السعر يجب أن يكون عددًا غير سالب'),
], updateOrder);

// Delete order
router.delete('/:id', auth, authorize('admin'), deleteOrder);

// Assign chef to order item
router.patch('/:id/assign-chef', [
  auth,
  authorize('admin', 'production'),
  body('itemId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف العنصر غير صالح'),
  body('chefId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الشيف غير صالح'),
], assignChef);

// Update item status
router.patch('/:id/item-status', [
  auth,
  authorize('chef', 'admin', 'production'),
  body('itemId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف العنصر غير صالح'),
  body('status').isIn(['pending', 'assigned', 'in_progress', 'completed']).withMessage('حالة العنصر غير صالحة'),
], updateItemStatus);

// Confirm delivery
router.patch('/:id/confirm-delivery', auth, authorize('admin', 'production'), confirmDelivery);

// Confirm order receipt by branch
router.patch('/:id/confirm-receipt', auth, authorize('branch'), confirmOrderReceipt);

module.exports = router;