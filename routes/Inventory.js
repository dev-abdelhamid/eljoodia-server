const express = require('express');
const { body } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  createInventory,
  getInventory,
  getInventoryByBranch,
  updateStock,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createReturn,
  processReturnItems,
} = require('../controllers/inventoryController');

const router = express.Router();

// Get all inventory items
router.get('/', auth, authorize(['branch', 'admin']), getInventory);

// Get inventory by branch
router.get('/branch/:branchId', auth, authorize(['branch', 'admin']), getInventoryByBranch);

// Create inventory item
router.post('/', [
  auth,
  authorize(['branch', 'admin']),
  body('branchId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('productId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('userId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف المستخدم غير صالح'),
  body('currentStock').isInt({ min: 0 }).withMessage('الكمية يجب أن تكون عددًا غير سالب'),
  body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى يجب أن يكون عددًا غير سالب'),
  body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى يجب أن يكون عددًا غير سالب'),
  body('orderId').optional().custom(value => mongoose.isValidObjectId(value)).withMessage('معرف الطلب غير صالح'),
], createInventory);

// Update inventory stock
router.put('/:id?', [
  auth,
  authorize(['branch', 'admin']),
  body('currentStock').optional().isInt({ min: 0 }).withMessage('الكمية يجب أن تكون عددًا غير سالب'),
  body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى يجب أن يكون عددًا غير سالب'),
  body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى يجب أن يكون عددًا غير سالب'),
  body('productId').optional().custom(value => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('branchId').optional().custom(value => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
], updateStock);

// Create restock request
router.post('/restock-requests', [
  auth,
  authorize(['branch']),
  body('productId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('branchId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('requestedQuantity').isInt({ min: 1 }).withMessage('الكمية المطلوبة يجب أن تكون أكبر من 0'),
  body('notes').optional().trim(),
], createRestockRequest);

// Get restock requests
router.get('/restock-requests', auth, authorize(['branch', 'admin']), getRestockRequests);

// Approve restock request
router.patch('/restock-requests/:requestId/approve', [
  auth,
  authorize(['admin']),
  body('approvedQuantity').isInt({ min: 1 }).withMessage('الكمية المعتمدة يجب أن تكون أكبر من 0'),
  body('userId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف المستخدم غير صالح'),
], approveRestockRequest);

// Get inventory history
router.get('/history', auth, authorize(['branch', 'admin']), getInventoryHistory);

// Create return request
router.post('/returns', [
  auth,
  authorize(['branch']),
  body('orderId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف الطلب غير صالح'),
  body('branchId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('reason').notEmpty().withMessage('سبب الإرجاع مطلوب'),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
  body('items.*.reason').notEmpty().withMessage('سبب الإرجاع للعنصر مطلوب'),
  body('notes').optional().trim(),
], createReturn);

// Process return items
router.put('/returns/:returnId/process', [
  auth,
  authorize(['admin']),
  body('branchId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.productId').custom(value => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
  body('items.*.status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون "approved" أو "rejected"'),
  body('items.*.reviewNotes').optional().trim(),
], processReturnItems);

module.exports = router;