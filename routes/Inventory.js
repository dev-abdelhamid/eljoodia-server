const express = require('express');
const { body } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const mongoose = require('mongoose');
const {
  getInventory,
  getInventoryByBranch,
  updateStock,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createReturn,
  createInventory,
} = require('../controllers/inventory');

const router = express.Router();

// Get all inventory items
router.get(
  '/',
  [auth, authorize(['branch', 'admin'])],
  getInventory
);

// Get inventory by branch
router.get(
  '/branch/:branchId',
  [
    auth,
    authorize(['branch', 'admin']),
    (req, res, next) => {
      if (!mongoose.isValidObjectId(req.params.branchId)) {
        return res.status(400).json({ message: 'معرف الفرع غير صالح' });
      }
      next();
    },
  ],
  getInventoryByBranch
);

// Update or create inventory stock
router.put(
  '/:id?',
  [
    auth,
    authorize(['branch', 'admin']),
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
    (req, res, next) => {
      if (req.params.id && !mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ message: 'معرف المخزون غير صالح' });
      }
      next();
    },
  ],
  updateStock
);

// Create inventory item
router.post(
  '/',
  [
    auth,
    authorize(['branch', 'admin']),
    body('branchId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    body('productId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('userId')
      .notEmpty()
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
      .isInt({ min: 1 })
      .withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا موجبًا'),
    body('orderId')
      .optional()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الطلبية غير صالح'),
  ],
  createInventory
);

// Create restock request
router.post(
  '/restock-requests',
  [
    auth,
    authorize(['branch']),
    body('productId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('branchId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    body('requestedQuantity')
      .isInt({ min: 1 })
      .withMessage('الكمية المطلوبة يجب أن تكون أكبر من 0'),
    body('notes')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('الملاحظات يجب ألا تتجاوز 500 حرف'),
  ],
  createRestockRequest
);

// Get restock requests
router.get(
  '/restock-requests',
  [auth, authorize(['branch', 'admin'])],
  getRestockRequests
);

// Approve restock request
router.patch(
  '/restock-requests/:requestId/approve',
  [
    auth,
    authorize(['admin']),
    body('approvedQuantity')
      .isInt({ min: 1 })
      .withMessage('الكمية المعتمدة يجب أن تكون أكبر من 0'),
    (req, res, next) => {
      if (!mongoose.isValidObjectId(req.params.requestId)) {
        return res.status(400).json({ message: 'معرف طلب إعادة التخزين غير صالح' });
      }
      next();
    },
  ],
  approveRestockRequest
);

// Get inventory history
router.get(
  '/history',
  [auth, authorize(['branch', 'admin'])],
  getInventoryHistory
);

// Create return request
router.post(
  '/returns',
  [
    auth,
    authorize(['branch']),
    body('orderId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الطلب غير صالح'),
    body('branchId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    body('reason')
      .notEmpty()
      .trim()
      .isLength({ min: 3, max: 500 })
      .withMessage('سبب الإرجاع يجب أن يكون بين 3 و500 حرف'),
    body('items')
      .isArray({ min: 1 })
      .withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity')
      .isInt({ min: 1 })
      .withMessage('الكمية يجب أن تكون أكبر من 0'),
    body('items.*.reason')
      .notEmpty()
      .trim()
      .isLength({ min: 3, max: 500 })
      .withMessage('سبب الإرجاع للعنصر يجب أن يكون بين 3 و500 حرف'),
    body('notes')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('الملاحظات يجب ألا تتجاوز 500 حرف'),
  ],
  createReturn
);

// Process return items
router.patch(
  '/returns/:returnId/process',
  [
    auth,
    authorize(['admin']),
    body('branchId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف الفرع غير صالح'),
    body('items')
      .isArray({ min: 1 })
      .withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId')
      .notEmpty()
      .custom((value) => mongoose.isValidObjectId(value))
      .withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity')
      .isInt({ min: 1 })
      .withMessage('الكمية يجب أن تكون أكبر من 0'),
    body('items.*.status')
      .isIn(['approved', 'rejected'])
      .withMessage('حالة العنصر يجب أن تكون "approved" أو "rejected"'),
    body('items.*.reviewNotes')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('ملاحظات المراجعة يجب ألا تتجاوز 500 حرف'),
    (req, res, next) => {
      if (!mongoose.isValidObjectId(req.params.returnId)) {
        return res.status(400).json({ message: 'معرف الإرجاع غير صالح' });
      }
      next();
    },
  ],
  require('../controllers/inventory').processReturnItems
);

module.exports = router;