const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  createInventory,
  bulkCreate,
  updateStock,
  createReturn,
  processReturnItems,
  getInventoryHistory,
  getProductInventoryDetails,
} = require('../controllers/inventory');

const router = express.Router();

// Validation for createInventory
const createInventoryValidation = [
  body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
  body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
  body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
];

// Validation for bulkCreate
const bulkCreateValidation = [
  body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
  body('items.*.minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
  body('items.*.maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  body('items.*.orderId').optional().custom((value) => value ? mongoose.isValidObjectId(value) : true).withMessage('معرف الطلب غير صالح'),
];

// Validation for updateStock
const updateStockValidation = [
  body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('quantity').isInt().withMessage('الكمية يجب أن تكون عددًا صحيحًا'),
  body('type').isIn(['in', 'out']).withMessage('النوع يجب أن يكون "in" أو "out"'),
];

// Validation for createReturn
const createReturnValidation = [
  body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('reason').isString().trim().notEmpty().withMessage('سبب الإرجاع مطلوب'),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
  body('items.*.reason').isString().trim().notEmpty().withMessage('سبب الإرجاع للعنصر مطلوب'),
  body('items.*.orderId').optional().custom((value) => value ? mongoose.isValidObjectId(value) : true).withMessage('معرف الطلب غير صالح'),
  body('notes').optional().isString().trim().withMessage('الملاحظات يجب أن تكون نصًا'),
];

// Validation for processReturnItems
const processReturnValidation = [
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
  body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون "approved" أو "rejected"'),
  body('items.*.reviewNotes').optional().isString().trim().withMessage('ملاحظات المراجعة يجب أن تكون نصًا'),
];

// Routes
router.get(
  '/',
  auth,
  authorize(['branch', 'admin']),
  [query('branch').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح')],
  getInventory
);

router.get(
  '/branch/:branchId',
  auth,
  authorize(['branch', 'admin']),
  [param('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح')],
  getInventoryByBranch
);

router.post(
  '/',
  auth,
  authorize(['branch', 'admin']),
  createInventoryValidation,
  createInventory
);

router.post(
  '/bulk',
  auth,
  authorize(['admin']),
  bulkCreateValidation,
  bulkCreate
);

router.post(
  '/update-stock',
  auth,
  authorize(['branch', 'admin']),
  updateStockValidation,
  updateStock
);

router.post(
  '/returns',
  auth,
  authorize(['branch']),
  createReturnValidation,
  createReturn
);

router.patch(
  '/returns/:returnId/process',
  auth,
  authorize(['admin']),
  [
    param('returnId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الإرجاع غير صالح'),
    ...processReturnValidation,
  ],
  processReturnItems
);

router.get(
  '/history',
  auth,
  authorize(['branch', 'admin']),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('page').optional().isInt({ min: 1 }).withMessage('الصفحة يجب أن تكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
  ],
  getInventoryHistory
);

router.get(
  '/product/:productId',
  auth,
  authorize(['branch', 'admin']),
  [
    param('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  ],
  getProductInventoryDetails
);

module.exports = router;