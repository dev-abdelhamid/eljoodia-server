import express from 'express';
import { body, param, query } from 'express-validator';
import { auth, authorize } from '../middleware/auth';
import {
  createFactoryOrder,
  getFactoryOrders,
  getFactoryOrderById,
  assignFactoryChefs,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
} from '../controllers/factoryOrderController';

const router = express.Router();

const validateOrderId = [
  param('id').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف الطلب غير صالح' : 'Invalid order ID'),
];

router.post(
  '/',
  [
    auth,
    authorize('production', 'admin'),
    body('orderNumber').trim().notEmpty().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'رقم الطلب مطلوب' : 'Order number is required'),
    body('items').isArray({ min: 1 }).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'العناصر مطلوبة' : 'Items are required'),
    body('items.*.product').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الكمية يجب أن تكون على الأقل 1' : 'Quantity must be at least 1'),
    body('notes').optional().isString().trim(),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الأولوية غير صالحة' : 'Invalid priority'),
  ],
  createFactoryOrder
);

router.get(
  '/',
  [
    auth,
    authorize('production', 'admin'),
    query('status').optional().isIn(['pending', 'approved', 'in_production', 'completed', 'cancelled']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'حالة غير صالحة' : 'Invalid status'),
    query('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الأولوية غير صالحة' : 'Invalid priority'),
  ],
  getFactoryOrders
);

router.get('/:id', [auth, authorize('production', 'admin'), ...validateOrderId], getFactoryOrderById);

router.patch(
  '/:id/assign',
  [
    auth,
    authorize('production', 'admin'),
    ...validateOrderId,
    body('items').isArray({ min: 1 }).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'مصفوفة العناصر مطلوبة' : 'Items array is required'),
    body('items.*.itemId').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف العنصر غير صالح' : 'Invalid itemId'),
    body('items.*.assignedTo').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف الشيف غير صالح' : 'Invalid assignedTo'),
    body('items.*.product').isString().trim().notEmpty().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'اسم المنتج مطلوب' : 'Product name is required'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الكمية يجب أن تكون على الأقل 1' : 'Quantity must be at least 1'),
    body('items.*.unit').isString().trim().notEmpty().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الوحدة مطلوبة' : 'Unit is required'),
  ],
  assignFactoryChefs
);

router.patch(
  '/:id/status',
  [
    auth,
    authorize('chef', 'production', 'admin'),
    ...validateOrderId,
    body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'cancelled']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'حالة غير صالحة' : 'Invalid status'),
  ],
  updateFactoryOrderStatus
);

router.patch('/:id/confirm-production', [auth, authorize('production', 'admin'), ...validateOrderId], confirmFactoryProduction);

export default router;