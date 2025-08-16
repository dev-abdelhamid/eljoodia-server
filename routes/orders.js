const express = require('express');
const { body } = require('express-validator');
const { 
  createOrder, 
  getOrders, 
  updateOrderStatus, 
  getChefTasks, 
  updateTaskStatus,
  assignChefs,
  confirmDelivery,
  approveReturn
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
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
], createOrder);

router.get('/', auth, getOrders);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
], updateOrderStatus);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.patch('/returns/:id/status', [
  auth,
  authorize('production', 'admin'),
  body('status').isIn(['pending', 'approved', 'rejected']).withMessage('Invalid return status'),
], approveReturn);

router.get('/chef/tasks', auth, authorize('chef'), getChefTasks);

router.patch('/:orderId/tasks/:productId/status', [
  auth,
  authorize('chef'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
], assignChefs);

module.exports = router;