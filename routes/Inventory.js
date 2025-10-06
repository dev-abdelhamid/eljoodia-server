const express = require('express');
const { body, query, param } = require('express-validator');
const mongoose = require('mongoose');
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

// جلب جميع عناصر المخزون مع دعم الفلترة حسب القسم
router.get(
  '/',
  auth,
  authorize(['branch', 'admin']),
  [
    query('department')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف القسم غير صالح'),
    query('branch')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    query('product')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    query('lowStock')
      .optional()
      .isBoolean()
      .withMessage('حالة المخزون المنخفض يجب أن تكون قيمة منطقية'),
    query('search')
      .optional()
      .isString()
      .trim()
      .withMessage('البحث يجب أن يكون نصًا'),
  ],
  getInventory
);

// جلب المخزون حسب الفرع
router.get(
  '/branch/:branchId',
  auth,
  authorize(['branch', 'admin']),
  [
    param('branchId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    query('department')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف القسم غير صالح'),
    query('search')
      .optional()
      .isString()
      .trim()
      .withMessage('البحث يجب أن يكون نصًا'),
  ],
  getInventoryByBranch
);

// إنشاء أو تحديث عنصر مخزون
router.put(
  '/:id?',
  auth,
  authorize(['branch', 'admin']),
  [
    param('id')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المخزون غير صالح'),
    body('currentStock')
      .optional()
      .isInt({ min: 0 })
      .withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel')
      .optional()
      .isInt({ min: 0 })
      .withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel')
      .optional()
      .isInt({ min: 0 })
      .withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
    body('productId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('branchId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
  ],
  updateStock
);

// إنشاء عنصر مخزون واحد
router.post(
  '/',
  auth,
  authorize(['branch', 'admin']),
  [
    body('branchId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    body('productId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('userId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المستخدم غير صالح'),
    body('currentStock')
      .isInt({ min: 0 })
      .withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel')
      .optional()
      .isInt({ min: 0 })
      .withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel')
      .optional()
      .isInt({ min: 0 })
      .withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
    body('orderId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الطلبية غير صالح'),
  ],
  createInventory
);

// إنشاء أو تحديث دفعة من عناصر المخزون
router.post(
  '/bulk',
  auth,
  authorize(['branch', 'admin']),
  [
    body('branchId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    body('userId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المستخدم غير صالح'),
    body('orderId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الطلبية غير صالح'),
    body('items')
      .isArray({ min: 1 })
      .withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('items.*.currentStock')
      .isInt({ min: 0 })
      .withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('items.*.minStockLevel')
      .optional()
      .isInt({ min: 0 })
      .withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('items.*.maxStockLevel')
      .optional()
      .isInt({ min: 0 })
      .withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  ],
  bulkCreate
);

// إنشاء طلب إعادة تخزين
router.post(
  '/restock-requests',
  auth,
  authorize(['branch']),
  [
    body('productId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('branchId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    body('requestedQuantity')
      .isInt({ min: 1 })
      .withMessage('الكمية المطلوبة يجب أن تكون أكبر من 0'),
    body('notes')
      .optional()
      .isString()
      .trim()
      .withMessage('الملاحظات يجب أن تكون نصًا'),
  ],
  createRestockRequest
);

// جلب طلبات إعادة التخزين
router.get(
  '/restock-requests',
  auth,
  authorize(['branch', 'admin']),
  [
    query('branchId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    query('status')
      .optional()
      .isIn(['pending', 'approved', 'rejected'])
      .withMessage('الحالة يجب أن تكون pending، approved، أو rejected'),
  ],
  getRestockRequests
);

// الموافقة على طلب إعادة تخزين
router.patch(
  '/restock-requests/:requestId/approve',
  auth,
  authorize(['admin']),
  [
    param('requestId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الطلب غير صالح'),
    body('approvedQuantity')
      .isInt({ min: 1 })
      .withMessage('الكمية المعتمدة يجب أن تكون أكبر من 0'),
    body('userId')
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المستخدم غير صالح'),
  ],
  approveRestockRequest
);

// جلب سجل المخزون
router.get(
  '/history',
  auth,
  authorize(['branch', 'admin']),
  [
    query('branchId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    query('productId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
  ],
  getInventoryHistory
);

module.exports = router;