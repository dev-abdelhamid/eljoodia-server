const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  updateStock,
  getInventoryHistory,
  createInventory,
  bulkCreate,
} = require('../controllers/inventory');
const mongoose = require('mongoose');

const router = express.Router();

// Get all inventory items for authorized users
router.get(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    query('branch').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    query('product').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف القسم غير صالح' : 'Invalid department ID'),
    query('lowStock').optional().isBoolean().withMessage((_, { req }) => req.query.lang === 'ar' ? 'حالة المخزون المنخفض يجب أن تكون قيمة منطقية' : 'Low stock status must be a boolean'),
    query('stockStatus').optional().isIn(['low', 'normal', 'high']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'حالة المخزون يجب أن تكون low، normal، أو high' : 'Stock status must be low, normal, or high'),
  ],
  getInventory
);

// Get inventory items by branch ID
router.get(
  '/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  [
    param('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف القسم غير صالح' : 'Invalid department ID'),
    query('stockStatus').optional().isIn(['low', 'normal', 'high']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'حالة المخزون يجب أن تكون low، normal، أو high' : 'Stock status must be low, normal, or high'),
  ],
  getInventoryByBranch
);

// Create or update inventory stock
router.put(
  '/:id',
  auth,
  authorize('branch', 'admin'),
  [
    param('id').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المخزون غير صالح' : 'Invalid inventory ID'),
    body('currentStock').optional().isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الكمية الحالية يجب أن تكون عددًا غير سالب' : 'Current stock must be a non-negative integer'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب' : 'Min stock level must be a non-negative integer'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب' : 'Max stock level must be a non-negative integer'),
    body('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
  ],
  updateStock
);

// Create a single inventory item
router.post(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المستخدم غير صالح' : 'Invalid user ID'),
    body('currentStock').isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الكمية الحالية يجب أن تكون عددًا غير سالب' : 'Current stock must be a non-negative integer'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب' : 'Min stock level must be a non-negative integer'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب' : 'Max stock level must be a non-negative integer'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الطلبية غير صالح' : 'Invalid order ID'),
  ],
  createInventory
);

// Bulk create or update inventory items
router.post(
  '/bulk',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المستخدم غير صالح' : 'Invalid user ID'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الطلبية غير صالح' : 'Invalid order ID'),
    body('items').isArray({ min: 1 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'يجب أن تحتوي العناصر على عنصر واحد على الأقل' : 'Items must contain at least one item'),
    body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    body('items.*.currentStock').isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الكمية الحالية يجب أن تكون عددًا غير سالب' : 'Current stock must be a non-negative integer'),
    body('items.*.minStockLevel').optional().isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب' : 'Min stock level must be a non-negative integer'),
    body('items.*.maxStockLevel').optional().isInt({ min: 0 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب' : 'Max stock level must be a non-negative integer'),
  ],
  bulkCreate
);

// Get inventory history with period filter
router.get(
  '/history',
  auth,
  authorize('branch', 'admin'),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    query('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف القسم غير صالح' : 'Invalid department ID'),
    query('period').optional().isIn(['daily', 'weekly', 'monthly']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الفترة يجب أن تكون يومية، أسبوعية، أو شهرية' : 'Period must be daily, weekly, or monthly'),
  ],
  getInventoryHistory
);

module.exports = router;