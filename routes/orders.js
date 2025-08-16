
const express = require('express');
const { body } = require('express-validator');
const { 
  createOrder, 
  getOrders, 
  updateOrderStatus, 
  assignChefs,
  confirmDelivery,
  approveReturn,
  getChefTasks,
  updateTaskStatus
} = require('../controllers/orderController');
const { createTask, getTasks, getChefTasks: getProductionChefTasks } = require('../controllers/productionController');
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
  authorize('admin', 'manager'),
  body('order').isMongoId().withMessage('Invalid order ID'),
  body('product').isMongoId().withMessage('Invalid product ID'),
  body('chef').isMongoId().withMessage('Invalid chef ID'),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('itemId').isMongoId().withMessage('Invalid itemId'),
], createTask);

router.get('/', auth, getTasks);

router.get('/chef/:chefId', [
  auth,
  body('chefId').isMongoId().withMessage('Invalid chef ID'),
], getProductionChefTasks);

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
  body('status').isIn(['pending_approval', 'approved', 'rejected', 'processed']).withMessage('Invalid return status'),
], approveReturn);

router.get('/chef/tasks/:chefId', auth, authorize('chef'), getChefTasks);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
], assignChefs);

module.exports = router;
