const express = require('express');
const { body } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getFactoryInventory,
  addProductionBatch,
  allocateToBranch,
  getFactoryRestockRequests,
  approveFactoryRestockRequest,
  getFactoryInventoryHistory,
} = require('../controllers/factoryInventoryController');

const router = express.Router();

// Get factory inventory
router.get('/', auth, authorize('admin'), getFactoryInventory);

// Add production batch
router.post('/production', [
  auth,
  authorize('admin'),
  body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
], addProductionBatch);

// Allocate to branch
router.post('/allocate', [
  auth,
  authorize('admin'),
  body('requestId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلب غير صالح'),
  body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
  body('allocatedQuantity').isInt({ min: 1 }).withMessage('الكمية المخصصة يجب أن تكون أكبر من 0'),
], allocateToBranch);

// Get factory restock requests
router.get('/restock-requests', auth, authorize('admin'), getFactoryRestockRequests);

// Approve factory restock request
router.patch('/restock-requests/:requestId/approve', [
  auth,
  authorize('admin'),
  body('approvedQuantity').isInt({ min: 1 }).withMessage('الكمية المعتمدة يجب أن تكون أكبر من 0'),
], approveFactoryRestockRequest);

// Get factory inventory history
router.get('/history', auth, authorize('admin'), getFactoryInventoryHistory);

module.exports = router;