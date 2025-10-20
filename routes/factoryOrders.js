const express = require('express');
const router = express.Router();
const { body, query, param } = require('express-validator');
const {
  createFactoryOrder,
  approveFactoryOrder,
  getFactoryOrders,
  getFactoryOrderById,
  assignFactoryChefs,
  updateItemStatus,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
  getAvailableProducts,
} = require('../controllers/factoryOrderController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

router.use(protect);

router.get(
  '/available-products',
  [
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  getAvailableProducts
);

router.get(
  '/',
  [
    query('status').optional().isIn(['requested', 'pending', 'approved', 'in_production', 'completed', 'stocked', 'cancelled']).withMessage('حالة غير صالحة'),
    query('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('أولوية غير صالحة'),
    query('department').optional().isMongoId().withMessage('معرف القسم غير صالح'),
    query('sortBy').optional().isIn(['createdAt', 'orderNumber', 'priority']).withMessage('معيار الترتيب غير صالح'),
    query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('ترتيب غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  getFactoryOrders
);

router.get(
  '/:id',
  [
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  getFactoryOrderById
);

router.post(
  '/',
  restrictTo('chef', 'admin', 'production'),
  [
    body('orderNumber').trim().notEmpty().withMessage('رقم الطلب مطلوب'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن يحتوي الطلب على عنصر واحد على الأقل'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عدد صحيح أكبر من 0'),
    body('items.*.assignedTo').optional().isMongoId().withMessage('معرف الشيف غير صالح'),
    body('notes').optional().isString().trim(),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('أولوية غير صالحة'),
  ],
  createFactoryOrder
);

router.put(
  '/:id/approve',
  restrictTo('admin', 'production'),
  [
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  approveFactoryOrder
);

router.put(
  '/:id/assign-chefs',
  restrictTo('admin', 'production'),
  [
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب تحديد عنصر واحد على الأقل للتعيين'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.assignedTo').optional().isMongoId().withMessage('معرف الشيف غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  assignFactoryChefs
);

router.put(
  '/:id/items/:itemId/status',
  restrictTo('chef', 'admin', 'production'),
  [
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    param('itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('status').isIn(['pending', 'assigned', 'in_progress', 'completed']).withMessage('حالة العنصر غير صالحة'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  updateItemStatus
);

router.put(
  '/:id/status',
  restrictTo('admin', 'production'),
  [
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('status').isIn(['requested', 'pending', 'approved', 'in_production', 'completed', 'stocked', 'cancelled']).withMessage('حالة الطلب غير صالحة'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  updateFactoryOrderStatus
);

router.put(
  '/:id/confirm-production',
  restrictTo('admin', 'production'),
  [
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  confirmFactoryProduction
);

module.exports = router;