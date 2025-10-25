const express = require('express');
const { body, param, query } = require('express-validator');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  getOrderById,
  checkOrderExists,
  approveOrder,
  startTransit,
  confirmOrderReceipt,
} = require('../controllers/orderController');
const { createTask, getTasks, getChefTasks, updateTaskStatus } = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
  headers: true,
});

router.get(
  '/:id/check',
  [auth, param('id').isMongoId().withMessage('Invalid order ID')],
  checkOrderExists
);

router.post(
  '/tasks',
  [
    auth,
    authorize('admin', 'production'),
    body('order').isMongoId().withMessage('Invalid order ID'),
    body('product').isMongoId().withMessage('Invalid product ID'),
    body('chef').isMongoId().withMessage('Invalid chef ID'),
    body('items.*.quantity').isFloat({ min: 0.1 }).withMessage('Quantity must be at least 0.1'),
    body('itemId').isMongoId().withMessage('Invalid itemId'),
  ],
  createTask
);

router.get('/tasks', auth, getTasks);

router.get(
  '/tasks/chef/:chefId',
  [auth, authorize('chef'), param('chefId').isMongoId().withMessage('Invalid chef ID')],
  getChefTasks
);

router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('items').isArray({ min: 1 }).withMessage('Items are required'),
    body('orderNumber').notEmpty().withMessage('Order number is required'),
    body('items.*.product').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isFloat({ min: 0.1 }).withMessage('Quantity must be at least 0.1'),
    body('items.*.price').isFloat({ min: 0 }).withMessage('Price must be non-negative'),
  ],
  createOrder
);

router.get(
  '/',
  [auth, query('branch').optional().isMongoId().withMessage('Invalid branch ID')],
  getOrders
);

router.get(
  '/:id',
  [auth, param('id').isMongoId().withMessage('Invalid order ID')],
  getOrderById
);

router.patch(
  '/:id/status',
  [
    auth,
    authorize('production', 'admin', 'branch'),
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('status')
      .isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'])
      .withMessage('Invalid status'),
  ],
  updateOrderStatus
);

router.patch(
  '/:id/confirm-delivery',
  [
    auth,
    authorize('branch'),
    confirmDeliveryLimiter,
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  confirmDelivery
);

router.patch(
  '/:id/confirm-receipt',
  [
    auth,
    authorize('branch'),
    confirmDeliveryLimiter,
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  confirmOrderReceipt
);

router.patch(
  '/:id/approve',
  [
    auth,
    authorize('admin', 'production'),
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  approveOrder
);

router.patch(
  '/:id/start-transit',
  [
    auth,
    authorize('production'),
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  startTransit
);

router.patch(
  '/:orderId/tasks/:taskId/status',
  [
    auth,
    authorize('chef'),
    param('orderId').isMongoId().withMessage('Invalid order ID'),
    param('taskId').isMongoId().withMessage('Invalid task ID'),
    body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
  ],
  updateTaskStatus
);

router.patch(
  '/:id/assign',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('items').isArray({ min: 1 }).withMessage('Items array is required'),
    body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
    body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
  ],
  assignChefs
);

module.exports = router;