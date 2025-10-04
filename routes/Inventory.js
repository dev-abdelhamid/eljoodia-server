const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  updateStockLimits,
  createReturn,
  getReturns,
  approveReturn
} = require('../controllers/inventory');

const router = express.Router();

router.get(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    query('branch').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('product').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('lowStock').optional().isBoolean().withMessage('حالة المخزون المنخفض يجب أن تكون قيمة منطقية'),
  ],
  getInventory
);

// Get inventory items by branch ID
router.get(
  '/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
  ],
  getInventoryByBranch
);


// تحديث min/max
router.patch('/:id/limits', auth, authorize('branch', 'admin'),
  [body('minStockLevel').isInt({ min: 0 }), body('maxStockLevel').isInt({ min: 0 })],
  updateStockLimits
);

// إنشاء مرتجع
router.post('/returns', auth, authorize('branch'),
  [
    body('branchId').isMongoId(),
    body('reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']),
    body('items').isArray({ min: 1 }),
    body('items.*.productId').isMongoId(),
    body('items.*.quantity').isInt({ min: 1 }),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'])
  ],
  createReturn
);

// جلب المرتجعات
router.get('/returns', auth, authorize('branch', 'admin'),
  [query('status').optional().isIn(['pending_approval', 'approved', 'rejected']), query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1 })],
  getReturns
);

// موافقة/رفض مرتجع
router.put('/returns/:id', auth, authorize('admin', 'production'),
  [param('id').isMongoId(), body('status').isIn(['approved', 'rejected'])],
  approveReturn
);

module.exports = router;