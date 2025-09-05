const express = require('express');
const { body, param } = require('express-validator');
const { createTask, getTasks, getChefTasks, updateTaskStatus } = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

router.post('/', [
  auth,
  authorize('admin', 'production'),
  body('order').isMongoId().withMessage('معرف الطلب غير صالح'),
  body('product').isMongoId().withMessage('معرف المنتج غير صالح'),
  body('chef').isMongoId().withMessage('معرف الشيف غير صالح'),
  body('quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون على الأقل 1'),
  body('itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
], createTask);

router.get('/', auth, getTasks);

router.get('/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage('معرف الشيف غير صالح'),
], getChefTasks);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  param('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
  param('taskId').isMongoId().withMessage('معرف المهمة غير صالح'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('حالة المهمة غير صالحة'),
], updateTaskStatus);

module.exports = router;