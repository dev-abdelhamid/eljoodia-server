const express = require('express');
const { body, param } = require('express-validator');
const {
  createOrderWithTasks,
  getOrders,
  getOrderById,
  approveOrder,
  startTransit,
  updateOrderStatus,
  confirmDelivery,
  approveReturn,
  getTasks,
  getChefTasks,
  updateTaskStatus
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

router.post('/', [
  auth,
  authorize('branch'),
  body('orderNumber').notEmpty().withMessage('Order number is required'),
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
  body('items.*.product').isMongoId().withMessage('Invalid product ID'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('items.*.price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('tasks').optional().isArray().withMessage('Tasks must be an array'),
  body('tasks.*.product').optional().isMongoId().withMessage('Invalid product ID in tasks'),
  body('tasks.*.chef').optional().isMongoId().withMessage('Invalid chef ID in tasks'),
  body('tasks.*.quantity').optional().isInt({ min: 1 }).withMessage('Task quantity must be at least 1'),
  body('tasks.*.itemId').optional().isMongoId().withMessage('Invalid itemId in tasks'),
  body('status').optional().isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
  body('priority').optional().isIn(['low', 'medium', 'high']).withMessage('Invalid priority'),
], createOrderWithTasks);

router.get('/', auth, getOrders);

router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage('Invalid order ID'),
], getOrderById);

router.put('/:id/approve', [
  auth,
  authorize('admin', 'production'),
  param('id').isMongoId().withMessage('Invalid order ID'),
], approveOrder);

router.put('/:id/transit', [
  auth,
  authorize('production'),
  param('id').isMongoId().withMessage('Invalid order ID'),
], startTransit);

router.put('/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
  body('notes').optional().isString().trim().withMessage('Notes must be a string'),
], updateOrderStatus);

router.put('/:id/delivery', [
  auth,
  authorize('branch'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.put('/return/:id', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid return ID'),
  body('status').isIn(['approved', 'rejected']).withMessage('Invalid return status'),
  body('reviewNotes').optional().isString().trim().withMessage('Review notes must be a string'),
], approveReturn);

router.get('/tasks', auth, getTasks);

router.get('/chef-tasks', [
  auth,
  authorize('chef'),
], getChefTasks);

router.put('/tasks/:id/status', [
  auth,
  authorize('chef'),
  param('id').isMongoId().withMessage('Invalid task ID'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

module.exports = router;