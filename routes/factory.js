const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getFactoryInventory,
  createFactoryProductionRequest,
  assignChefToRequest,
  completeProductionRequest,
  getFactoryProductionRequests,
  getFactoryInventoryHistory,
} = require('../controllers/factoryController');
const mongoose = require('mongoose');

const router = express.Router();

router.get(
  '/',
  auth,
  authorize('admin', 'production_manager'),
  [
    query('product').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
  ],
  getFactoryInventory
);

router.post(
  '/production-requests',
  auth,
  authorize('admin', 'production_manager'),
  [
    body('type').isIn(['branch', 'production']).withMessage('نوع الطلب يجب أن يكون branch أو production'),
    body('branchId').if(body('type').equals('branch')).custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('العناصر مطلوبة'),
    body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
    body('notes').optional().trim(),
  ],
  createFactoryProductionRequest
);

router.put(
  '/production-requests/assign',
  auth,
  authorize('admin', 'production_manager'),
  [
    body('requestId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلب غير صالح'),
    body('chefId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الشيف غير صالح'),
  ],
  assignChefToRequest
);

router.put(
  '/production-requests/:requestId/complete',
  auth,
  authorize('admin', 'production_manager'),
  [
    param('requestId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلب غير صالح'),
  ],
  completeProductionRequest
);

router.get(
  '/production-requests',
  auth,
  authorize('admin', 'production_manager'),
  [
    query('type').optional().isIn(['branch', 'production']).withMessage('نوع الطلب يجب أن يكون branch أو production'),
    query('status').optional().isIn(['pending', 'assigned', 'in_progress', 'completed', 'delivered', 'rejected']).withMessage('حالة الطلب غير صالحة'),
  ],
  getFactoryProductionRequests
);

router.get(
  '/history',
  auth,
  authorize('admin', 'production_manager'),
  [
    query('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('period').optional().isIn(['daily', 'weekly', 'monthly']).withMessage('الفترة يجب أن تكون يومية، أسبوعية، أو شهرية'),
    query('groupBy').optional().isIn(['day', 'week', 'month']).withMessage('التجميع يجب أن يكون يومي، أسبوعي، أو شهري'),
  ],
  getFactoryInventoryHistory
);

module.exports = router;