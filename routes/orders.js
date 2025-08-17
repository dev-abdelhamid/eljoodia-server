const express = require('express');
const { body, param } = require('express-validator');
const { 
  createOrder, 
  getOrders, 
  updateOrderStatus, 
  assignChefs,
  confirmDelivery,
  approveReturn
} = require('../controllers/orderController');
const { 
  createTask, 
  getTasks, 
  getChefTasks, 
  updateTaskStatus 
} = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiter for confirmDelivery to prevent abuse
const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
  headers: true,
});

// Create a new production task
router.post('/tasks', [
  auth,
  authorize(['admin', 'production']),
  body('order').isMongoId().withMessage('Invalid order ID'),
  body('product').isMongoId().withMessage('Invalid product ID'),
  body('chef').isMongoId().withMessage('Invalid chef ID'),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('itemId').isMongoId().withMessage('Invalid itemId'),
], createTask);

// Get all production tasks
router.get('/tasks', [
  auth,
  authorize(['admin', 'production']),
], getTasks);

// Get tasks for a specific chef
router.get('/tasks/chef/:chefId', [
  auth,
  authorize(['chef', 'admin', 'production']),
  param('chefId').isMongoId().withMessage('Invalid chef ID'),
], getChefTasks);

// Create a new order
router.post('/', [
  auth,
  authorize(['branch', 'admin']),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.product').isMongoId().withMessage('Invalid product ID'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('items.*.price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('branchId').optional().isMongoId().withMessage('Invalid branch ID'),
], createOrder);

// Get all orders
router.get('/', [
  auth,
  authorize(['branch', 'admin', 'production']),
], getOrders);

// Update order status
router.patch('/:id/status', [
  auth,
  authorize(['production', 'admin']),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
  body('notes').optional().isString().trim(),
], updateOrderStatus);

// Confirm delivery
router.patch('/:id/confirm-delivery', [
  auth,
  authorize(['branch']),
  param('id').isMongoId().withMessage('Invalid order ID'),
  confirmDeliveryLimiter,
], confirmDelivery);

// Approve or reject a return request
router.patch('/returns/:id/status', [
  auth,
  authorize(['production', 'admin']),
  param('id').isMongoId().withMessage('Invalid return ID'),
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage('Invalid return status'),
  body('reviewNotes').optional().isString().trim(),
], approveReturn);

// Update task status
router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize(['chef']),
  param('orderId').isMongoId().withMessage('Invalid order ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

// Assign chefs to order items
router.patch('/:id/assign', [
  auth,
  authorize(['production', 'admin']),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo ID'),
], assignChefs);

module.exports = router;