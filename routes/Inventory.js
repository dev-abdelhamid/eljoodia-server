const express = require('express');
const { body, query } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  updateStock,
  updateStockLimits,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createReturn,
  createInventory,
  bulkCreate,
  processReturnItems,
  getReturns,
  getReturnById,
} = require('../controllers/inventory');

const router = express.Router();

// Get all inventory items
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

// Update stock limits (minStockLevel, maxStockLevel) only
router.patch(
  '/:id/limits',
  auth,
  authorize('branch', 'admin'),
  [
    body('minStockLevel').isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  ],
  updateStockLimits
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
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
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

// Get inventory history
router.get(
  '/history',
  auth,
  authorize('branch', 'admin'),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
  ],
  getInventoryHistory
);

// Create a return request
router.post(
  '/returns',
  auth,
  authorize('branch'),
  [
    body('orderId').optional().custom((value) => value ? mongoose.isValidObjectId(value) : true).withMessage('معرف الطلب غير صالح'),
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('reason').isString().notEmpty().trim().withMessage('سبب الإرجاع مطلوب'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
    body('items.*.reason').isString().notEmpty().trim().withMessage('سبب الإرجاع للعنصر مطلوب'),
    body('notes').optional().isString().trim().withMessage('الملاحظات يجب أن تكون نصًا'),
  ],
  createReturn
);

// Process return items
router.patch(
  '/returns/:returnId/process',
  auth,
  authorize('admin'),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
    body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون "approved" أو "rejected"'),
    body('items.*.reviewNotes').optional().isString().trim().withMessage('ملاحظات المراجعة يجب أن تكون نصًا'),
  ],
  processReturnItems
);

// Get all returns
router.get(
  '/returns',
  auth,
  authorize('branch', 'admin'),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('status').optional().isIn(['pending_approval', 'approved', 'rejected']).withMessage('حالة المرتجع غير صالحة'),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
  ],
  getReturns
);

// Get return by ID
router.get(
  '/returns/:returnId',
  auth,
  authorize('branch', 'admin'),
  getReturnById
);

module.exports = router;