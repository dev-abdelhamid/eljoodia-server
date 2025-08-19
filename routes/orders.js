const express = require('express');
const { body, param } = require('express-validator');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  approveReturn,
  syncAllOrders,
} = require('../controllers/orderController');
const { createTask, getTasks, getChefTasks, updateTaskStatus } = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
});

router.post('/', [
  auth,
  authorize('branch'),
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
  body('items.*.product').isMongoId().withMessage('Invalid product ID'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('items.*.price').isFloat({ min: 0 }).withMessage('Price must be non-negative'),
], createOrder);

router.get('/', auth, getOrders);

router.get('/sync-all', auth, authorize('admin'), syncAllOrders);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
], updateOrderStatus);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.patch('/returns/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid return ID'),
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage('Invalid return status'),
], approveReturn);

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

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  param('orderId').isMongoId().withMessage('Invalid order ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
], assignChefs);

module.exports = router;