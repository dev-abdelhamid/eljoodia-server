const express = require('express');
const { body, query } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  updateStock,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createInventory,
  bulkCreate,
} = require('../controllers/inventory');

const router = express.Router();

// Get all inventory items for authorized users
router.get(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    query('branch').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('product').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
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
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
  ],
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

// Get all restock requests
router.get(
  '/restock-requests',
  auth,
  authorize('branch', 'admin'),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  ],
  getRestockRequests
);

// Approve a restock request
router.patch(
  '/restock-requests/:requestId/approve',
  auth,
  authorize('admin'),
  [
    body('approvedQuantity').isInt({ min: 1 }).withMessage('الكمية المعتمدة يجب أن تكون أكبر من 0'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المستخدم غير صالح'),
  ],
  approveRestockRequest
);

// Get inventory history with period filter
router.get(
  '/history',
  auth,
  authorize('branch', 'admin'),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
    query('period').optional().isIn(['daily', 'weekly', 'monthly']).withMessage('الفترة يجب أن تكون يومية، أسبوعية، أو شهرية'),
  ],
  getInventoryHistory
);

module.exports = router;