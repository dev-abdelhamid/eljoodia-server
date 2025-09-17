const express = require('express');
const { body } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  updateStock,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createReturn,
  createInventory, // إضافة دالة جديدة
} = require('../controllers/inventory');

const router = express.Router();

// Get all inventory items
router.get('/', auth, authorize('branch', 'admin'), getInventory);

// Get inventory by branch
router.get('/branch/:branchId', auth, authorize('branch', 'admin'), getInventoryByBranch);

// Update or create inventory stock
router.put('/:id?', [
  auth,
  authorize('branch', 'admin'),
  body('currentStock').optional().isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
  body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
  body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  body('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
], updateStock);

// Create inventory item
router.post('/', [
  auth,
  authorize('branch', 'admin'),
  body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
  body('minStockLevel').isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
  body('maxStockLevel').isInt({ min: 1 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا موجبًا'),
], createInventory);

// Create restock request
router.post('/restock-requests', [
  auth,
  authorize('branch'),
  body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('requestedQuantity').isInt({ min: 1 }).withMessage('الكمية المطلوبة يجب أن تكون أكبر من 0'),
], createRestockRequest);

// Get restock requests
router.get('/restock-requests', auth, authorize('branch', 'admin'), getRestockRequests);

// Approve restock request
router.patch('/restock-requests/:requestId/approve', [
  auth,
  authorize('admin'),
  body('approvedQuantity').isInt({ min: 1 }).withMessage('الكمية المعتمدة يجب أن تكون أكبر من 0'),
], approveRestockRequest);

// Get inventory history
router.get('/history', auth, authorize('branch', 'admin'), getInventoryHistory);

// Create return request
router.post('/returns', [
  auth,
  authorize('branch'),
  body('order').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلب غير صالح'),
  body('branch').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
  body('reason').notEmpty().withMessage('سبب الإرجاع مطلوب'),
  body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
  body('items.*.product').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
  body('items.*.reason').notEmpty().withMessage('سبب الإرجاع للعنصر مطلوب'),
], createReturn);

module.exports = router;