const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventoryByBranch,
  updateStockLimits,
  createReturn,
  getReturns,
  approveReturn
} = require('../controllers/inventory');

const router = express.Router();

// جلب مخزون الفرع
router.get('/branch/:branchId', auth, authorize('branch', 'admin'), getInventoryByBranch);

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