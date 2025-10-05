const express = require('express');
const router = express.Router();
const { body, query } = require('express-validator');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const inventoryController = require('../controllers/inventory');
const inventoryStockController = require('../controllers/inventoryStock');

// Validation middleware
const validateId = (field) =>
  body(field).custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error(`معرف ${field} غير صالح`);
    }
    return true;
  });

const validateInventoryCreate = [
  body('branchId').notEmpty().withMessage('معرف الفرع مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف الفرع غير صالح');
    }
    return true;
  }),
  body('productId').notEmpty().withMessage('معرف المنتج مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المنتج غير صالح');
    }
    return true;
  }),
  body('currentStock').isInt({ min: 0 }).withMessage('كمية المخزون يجب أن تكون عددًا صحيحًا غير سالب'),
  body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
  body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
  body('userId').notEmpty().withMessage('معرف المستخدم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المستخدم غير صالح');
    }
    return true;
  }),
  body('orderId').optional().custom((value) => {
    if (value && !mongoose.isValidObjectId(value)) {
      throw new Error('معرف الطلب غير صالح');
    }
    return true;
  }),
];

const validateBulkCreate = [
  body('branchId').notEmpty().withMessage('معرف الفرع مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف الفرع غير صالح');
    }
    return true;
  }),
  body('userId').notEmpty().withMessage('معرف المستخدم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المستخدم غير صالح');
    }
    return true;
  }),
  body('orderId').optional().custom((value) => {
    if (value && !mongoose.isValidObjectId(value)) {
      throw new Error('معرف الطلب غير صالح');
    }
    return true;
  }),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').notEmpty().withMessage('معرف المنتج مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المنتج غير صالح');
    }
    return true;
  }),
  body('items.*.currentStock').isInt({ min: 0 }).withMessage('كمية المخزون يجب أن تكون عددًا صحيحًا غير سالب'),
  body('items.*.minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
  body('items.*.maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
];

const validateStockUpdate = [
  validateId('id').withMessage('معرف المخزون غير صالح'),
  body('currentStock').optional().isInt({ min: 0 }).withMessage('كمية المخزون يجب أن تكون عددًا صحيحًا غير سالب'),
  body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
  body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
  body('userId').notEmpty().withMessage('معرف المستخدم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المستخدم غير صالح');
    }
    return true;
  }),
];

const validateStockLimitsUpdate = [
  validateId('id').withMessage('معرف المخزون غير صالح'),
  body('minStockLevel').isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
  body('maxStockLevel').isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا صحيحًا غير سالب'),
  body('userId').notEmpty().withMessage('معرف المستخدم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المستخدم غير صالح');
    }
    return true;
  }),
];

const validateCreateReturn = [
  body('branchId').notEmpty().withMessage('معرف الفرع مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف الفرع غير صالح');
    }
    return true;
  }),
  body('userId').notEmpty().withMessage('معرف المستخدم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المستخدم غير صالح');
    }
    return true;
  }),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').notEmpty().withMessage('معرف المنتج مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المنتج غير صالح');
    }
    return true;
  }),
  body('items.*.itemId').notEmpty().withMessage('معرف عنصر المخزون مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف عنصر المخزون غير صالح');
    }
    return true;
  }),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا أكبر من 0'),
  body('items.*.reason').notEmpty().withMessage('سبب المرتجع مطلوب'),
  body('reason').notEmpty().withMessage('سبب المرتجع العام مطلوب'),
  body('notes').optional().trim(),
  body('orderId').optional().custom((value) => {
    if (value && !mongoose.isValidObjectId(value)) {
      throw new Error('معرف الطلب غير صالح');
    }
    return true;
  }),
];

const validateApproveReturn = [
  validateId('id').withMessage('معرف المرتجع غير صالح'),
  body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما "approved" أو "rejected"'),
  body('userId').notEmpty().withMessage('معرف المستخدم مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المستخدم غير صالح');
    }
    return true;
  }),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').notEmpty().withMessage('معرف المنتج مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف المنتج غير صالح');
    }
    return true;
  }),
  body('items.*.inventoryId').notEmpty().withMessage('معرف عنصر المخزون مطلوب').custom((value) => {
    if (!mongoose.isValidObjectId(value)) {
      throw new Error('معرف عنصر المخزون غير صالح');
    }
    return true;
  }),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا أكبر من 0'),
  body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون إما "approved" أو "rejected"'),
  body('reviewNotes').optional().trim(),
];

// Routes
router.get(
  '/',
  authenticateToken,
  [
    query('branch').optional().custom((value) => {
      if (value && !mongoose.isValidObjectId(value)) {
        throw new Error('معرف الفرع غير صالح');
      }
      return true;
    }),
    query('product').optional().custom((value) => {
      if (value && !mongoose.isValidObjectId(value)) {
        throw new Error('معرف المنتج غير صالح');
      }
      return true;
    }),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  inventoryController.getInventory
);

router.get(
  '/branch/:branchId',
  authenticateToken,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('search').optional().trim(),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  inventoryController.getInventoryByBranch
);

router.post(
  '/',
  authenticateToken,
  authorizeRole(['admin', 'branch']),
  validateInventoryCreate,
  inventoryController.createInventory
);

router.post(
  '/bulk',
  authenticateToken,
  authorizeRole(['admin']),
  validateBulkCreate,
  inventoryController.bulkCreate
);

router.get(
  '/history',
  authenticateToken,
  [
    query('branchId').optional().custom((value) => {
      if (value && !mongoose.isValidObjectId(value)) {
        throw new Error('معرف الفرع غير صالح');
      }
      return true;
    }),
    query('productId').optional().custom((value) => {
      if (value && !mongoose.isValidObjectId(value)) {
        throw new Error('معرف المنتج غير صالح');
      }
      return true;
    }),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  inventoryController.getInventoryHistory
);

router.get(
  '/product/:productId/branch/:branchId',
  authenticateToken,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  inventoryController.getProductDetails
);

router.put(
  '/stock/:id',
  authenticateToken,
  authorizeRole(['admin', 'branch']),
  validateStockUpdate,
  inventoryStockController.updateStock
);

router.put(
  '/limits/:id',
  authenticateToken,
  authorizeRole(['admin']),
  validateStockLimitsUpdate,
  inventoryStockController.updateStockLimits
);

router.post(
  '/return',
  authenticateToken,
  authorizeRole(['admin', 'branch']),
  validateCreateReturn,
  inventoryStockController.createReturn
);

router.get(
  '/returns',
  authenticateToken,
  [
    query('branchId').optional().custom((value) => {
      if (value && !mongoose.isValidObjectId(value)) {
        throw new Error('معرف الفرع غير صالح');
      }
      return true;
    }),
    query('status').optional().isIn(['pending_approval', 'approved', 'rejected']).withMessage('الحالة يجب أن تكون إما "pending_approval" أو "approved" أو "rejected"'),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا أكبر من 0'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة يجب أن تكون "ar" أو "en"'),
  ],
  inventoryStockController.getReturns
);

router.put(
  '/return/:id',
  authenticateToken,
  authorizeRole(['admin']),
  validateApproveReturn,
  inventoryStockController.approveReturn
);

module.exports = router;