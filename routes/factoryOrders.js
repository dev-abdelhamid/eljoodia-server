const express = require('express');
const { body, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  createFactoryOrder,
  getFactoryOrders,
  assignFactoryChefs,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
  getFactoryOrderById,
} = require('../controllers/factoryOrderController');

const router = express.Router();

router.post('/', [
  auth,
  authorize('production', 'admin'),
  body('orderNumber').trim().notEmpty().withMessage('Order number is required'),
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
  body('items.*.product').isMongoId().withMessage('Invalid product ID'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('items.*.price').isNumeric({ min: 0 }).withMessage('Invalid price'),
], createFactoryOrder);

router.get('/', auth, authorize('production', 'admin'), getFactoryOrders);

router.get('/:id', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
], getFactoryOrderById);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
], assignFactoryChefs);

router.patch('/:id/status', [
  auth,
  authorize('chef', 'production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('status').isIn(['pending', 'in_production', 'completed', 'cancelled']).withMessage('Invalid status'),
], updateFactoryOrderStatus);

router.patch('/:id/confirm-production', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
], confirmFactoryProduction);

module.exports = router;