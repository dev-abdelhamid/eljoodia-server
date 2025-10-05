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
} = require('../controllers/inventoryController');

const router = express.Router();

// Middleware to set language context for virtual fields
const setLanguageContext = (req, res, next) => {
  const lang = req.headers['accept-language'] || req.query.lang || 'ar';
  req.languageContext = { isRtl: lang.includes('ar') };
  next();
};

// Apply language context to all routes
router.use(setLanguageContext);

// Get all inventory items for authorized users
router.get(
  '/',
  auth,
  authorize(['branch', 'admin']),
  [
    query('branch').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid branch ID'),
    query('product').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid product ID'),
    query('lowStock').optional().isBoolean().withMessage('lowStock must be a boolean'),
  ],
  getInventory
);

// Get inventory items by branch ID
router.get(
  '/branch/:branchId',
  auth,
  authorize(['branch', 'admin']),
  [
    query('lang').optional().isIn(['ar', 'en']).withMessage('Language must be "ar" or "en"'),
  ],
  getInventoryByBranch
);

// Create or update inventory stock
router.put(
  '/:id?',
  auth,
  authorize(['branch', 'admin']),
  [
    body('currentStock').optional().isInt({ min: 0 }).withMessage('Current stock must be a non-negative integer'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('Minimum stock level must be a non-negative integer'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('Maximum stock level must be a non-negative integer'),
    body('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid product ID'),
    body('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid branch ID'),
  ],
  updateStock
);

// Create a single inventory item
router.post(
  '/',
  auth,
  authorize(['branch', 'admin']),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid branch ID'),
    body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid product ID'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid user ID'),
    body('currentStock').isInt({ min: 0 }).withMessage('Current stock must be a non-negative integer'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('Minimum stock level must be a non-negative integer'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('Maximum stock level must be a non-negative integer'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid order ID'),
  ],
  createInventory
);

// Bulk create or update inventory items
router.post(
  '/bulk',
  auth,
  authorize(['branch', 'admin']),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid branch ID'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid user ID'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid order ID'),
    body('items').isArray({ min: 1 }).withMessage('Items must contain at least one entry'),
    body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid product ID'),
    body('items.*.currentStock').isInt({ min: 0 }).withMessage('Current stock must be a non-negative integer'),
    body('items.*.minStockLevel').optional().isInt({ min: 0 }).withMessage('Minimum stock level must be a non-negative integer'),
    body('items.*.maxStockLevel').optional().isInt({ min: 0 }).withMessage('Maximum stock level must be a non-negative integer'),
  ],
  bulkCreate
);

// Create a restock request
router.post(
  '/restock-requests',
  auth,
  authorize(['branch']),
  [
    body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid product ID'),
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid branch ID'),
    body('requestedQuantity').isInt({ min: 1 }).withMessage('Requested quantity must be greater than 0'),
    body('notes').optional().isString().trim().withMessage('Notes must be a string'),
  ],
  createRestockRequest
);

// Get all restock requests
router.get(
  '/restock-requests',
  auth,
  authorize(['branch', 'admin']),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid branch ID'),
  ],
  getRestockRequests
);

// Approve a restock request
router.patch(
  '/restock-requests/:requestId/approve',
  auth,
  authorize(['admin']),
  [
    body('approvedQuantity').isInt({ min: 1 }).withMessage('Approved quantity must be greater than 0'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid user ID'),
  ],
  approveRestockRequest
);

// Get inventory history
router.get(
  '/history',
  auth,
  authorize(['branch', 'admin']),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid branch ID'),
    query('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('Invalid product ID'),
  ],
  getInventoryHistory
);

module.exports = router;