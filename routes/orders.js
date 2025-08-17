const express = require('express');
const { body, param } = require('express-validator');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  approveReturn,
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

// Rate limiter for confirm delivery endpoint
const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests to confirm delivery. Please try again later.',
  headers: true,
});

// Create a task
router.post(
  '/tasks',
  [
    auth,
    authorize(['admin', 'production']),
    body('order').isMongoId().withMessage('Invalid order ID'),
    body('product').isMongoId().withMessage('Invalid product ID'),
    body('chef').isMongoId().withMessage('Invalid chef ID'),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('itemId').isMongoId().withMessage('Invalid itemId'),
  ],
  createTask
);

// Get all tasks
router.get('/tasks', auth, getTasks);

// Get tasks for a specific chef
router.get(
  '/tasks/chef/:chefId',
  [
    auth,
    authorize(['chef']),
    param('chefId').isMongoId().withMessage('Invalid chef ID'),
  ],
  getChefTasks
);

// Create an order
router.post(
  '/',
  [
    auth,
    authorize(['branch']),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('items.*.price').isFloat({ min: 0 }).withMessage('Price must be non-negative'),
  ],
  createOrder
);

// Get all orders
router.get('/', auth, getOrders);

// Update order status
router.patch(
  '/:id/status',
  [
    auth,
    authorize(['production', 'admin']),
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('status')
      .isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'])
      .withMessage('Invalid status'),
  ],
  updateOrderStatus
);

// Confirm delivery
router.patch(
  '/:id/confirm-delivery',
  [auth, authorize(['branch']), confirmDeliveryLimiter, param('id').isMongoId().withMessage('Invalid order ID')],
  confirmDelivery
);

// Approve or update return status
router.patch(
  '/returns/:id/status',
  [
    auth,
    authorize(['production', 'admin']),
    param('id').isMongoId().withMessage('Invalid return ID'),
    body('status')
      .isIn(['pending_approval', 'approved', 'rejected', 'processed'])
      .withMessage('Invalid return status'),
  ],
  approveReturn
);

// Update task status
router.patch(
  '/:orderId/tasks/:taskId/status',
  [
    auth,
    authorize(['chef']),
    param('orderId').isMongoId().withMessage('Invalid order ID'),
    param('taskId').isMongoId().withMessage('Invalid task ID'),
    body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
  ],
  updateTaskStatus
);

// Assign chefs to order items
router.patch(
  '/:id/assign',
  [
    auth,
    authorize(['production', 'admin']),
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
    body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo ID'),
  ],
  assignChefs
);

module.exports = router;