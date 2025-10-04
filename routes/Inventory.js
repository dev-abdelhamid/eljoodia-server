const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
    updateStock,
  updateStockLimits,
  bulkCreate,
  createInventory,
  createReturn,
  getReturns,
  approveReturn,
  getInventoryHistory
} = require('../controllers/inventory');

const router = express.Router();

// Get all inventory items for authorized users
router.get(
  '/',
  auth,
  authorize('branch', 'admin'),
  getInventory
);

// Get inventory items by branch ID
router.get(
  '/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  getInventoryByBranch
);

// Create or update inventory stock
router.put(
  '/:id?',
  auth,
  authorize('branch', 'admin'),
  [
    body('currentStock').optional().isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
    body('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  ],
  updateStock
);

// Create a single inventory item
router.post(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المستخدم غير صالح'),
    body('currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلبية غير صالح'),
  ],
  createInventory
);

// Bulk create or update inventory items
router.post(
  '/bulk',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المستخدم غير صالح'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلبية غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('items.*.currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('items.*.minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('items.*.maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  ],
  bulkCreate
);

// Create a restock request
router.post(
  '/restock-requests',
  auth,
  authorize('branch'),
  [
    body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('requestedQuantity').isInt({ min: 1 }).withMessage('الكمية المطلوبة يجب أن تكون أكبر من 0'),
    body('notes').optional().isString().trim().withMessage('الملاحظات يجب أن تكون نصًا'),
  ],
  createRestockRequest
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

router.get(
  '/history',
  auth,
  authorize('branch', 'admin'),
  getInventoryHistory
);

module.exports = router;