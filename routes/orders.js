const express = require('express');
const { body, param } = require('express-validator');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  approveReturn,
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
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
  authorize('chef', 'admin', 'production'),
  param('chefId').isMongoId().withMessage('Invalid chef ID'),
], getChefTasks);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  param('orderId').isMongoId().withMessage('Invalid order ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

router.post('/', [
  auth,
  authorize('branch', 'admin'),
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
  body('items.*.productId').isMongoId().withMessage('Invalid product ID'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('items.*.price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('orderNumber').notEmpty().withMessage('Order number is required'),
], createOrder);

router.get('/', auth, getOrders);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
], updateOrderStatus);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.patch('/returns/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid return ID'),
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage('Invalid return status'),
], approveReturn);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
], assignChefs);

module.exports = router;