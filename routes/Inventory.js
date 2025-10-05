// routes/inventory.js
const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  getInventoryHistory,
  getProductDetails,
} = require('../controllers/inventory');
const {
  createInventory,
  bulkCreate,
  updateStock,
  updateStockLimits,
} = require('../controllers/inventoryStock');
const { getReturnableOrdersForProduct, getProductHistory } = require('../controllers/inventory'); // Assuming in inventoryController for simplicity

const router = express.Router();

// Get all inventory items (admin or branch-specific)
router.get(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    query('branch').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    query('product').optional().isMongoId().withMessage('معرف المنتج غير صالح'),
    query('lowStock').optional().isBoolean().withMessage('حالة المخزون المنخفض غير صالحة'),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
  ],
  getInventory
);

// Get inventory by branch ID with pagination and search
router.get(
  '/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  [
    param('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('search').optional().isString().trim(),
    query('lowStock').optional().isBoolean().withMessage('حالة المخزون المنخفض غير صالحة'),
  ],
  getInventoryByBranch
);

// Create a single inventory item
router.post(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('userId').isMongoId().withMessage('معرف المستخدم غير صالح'),
    body('currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
    body('orderId').optional().isMongoId().withMessage('معرف الطلبية غير صالح'),
  ],
  createInventory
);

// Bulk create or update inventory items
router.post(
  '/bulk',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('userId').isMongoId().withMessage('معرف المستخدم غير صالح'),
    body('orderId').optional().isMongoId().withMessage('معرف الطلبية غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('items.*.minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('items.*.maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  ],
  bulkCreate
);

// Update inventory stock
router.put(
  '/:id',
  auth,
  authorize('branch', 'admin'),
  [
    param('id').isMongoId().withMessage('معرف المخزون غير صالح'),
    body('currentStock').optional().isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  ],
  updateStock
);

// Update stock limits (min/max)
router.patch(
  '/:id/limits',
  auth,
  authorize('branch', 'admin'),
  [
    param('id').isMongoId().withMessage('معرف المخزون غير صالح'),
    body('minStockLevel').isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  ],
  updateStockLimits
);

// Get returnable orders for product
router.get(
  '/returnable-orders/:productId/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  param('productId').isMongoId().withMessage('معرف المنتج غير صالح'),
  param('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
  getReturnableOrdersForProduct
);

// Get product history
router.get(
  '/product-history/:productId/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  param('productId').isMongoId().withMessage('معرف المنتج غير صالح'),
  param('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
  getProductHistory
);

// Get product details, movements, transfers, and statistics
router.get(
  '/product/:productId/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  [
    param('productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    param('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
  ],
  getProductDetails
);

module.exports = router;