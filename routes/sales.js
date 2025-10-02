const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, query } = require('express-validator');
const {
  createSale,
  getSales,
  getSaleById,
  updateSale,
  deleteSale,
  exportSalesReport,
} = require('../controllers/sales');

router.post(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    body('branch').isMongoId().withMessage('Invalid branch ID'),
    body('items').isArray({ min: 1 }).withMessage('Items must contain at least one item'),
    body('items.*.product').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('Unit price must be a non-negative number'),
    body('totalAmount').isFloat({ min: 0 }).withMessage('Total amount must be a non-negative number'),
    body('status').optional().isIn(['completed', 'pending', 'canceled']).withMessage('Invalid status'),
    body('paymentMethod').optional().isIn(['cash', 'card', 'credit']).withMessage('Invalid payment method'),
    body('customerName').optional().trim(),
    body('customerPhone').optional().trim(),
    body('notes').optional().trim(),
  ],
  createSale
);

router.get(
  '/',
  [
    auth,
    authorize('branch', 'admin', 'production'),
    query('branch').optional().isMongoId().withMessage('Invalid branch ID'),
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1 }).withMessage('Limit must be a positive integer'),
    query('status').optional().isIn(['completed', 'pending', 'canceled']).withMessage('Invalid status'),
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
  ],
  getSales
);

router.get(
  '/:id',
  [
    auth,
    authorize('branch', 'admin', 'production'),
    query('id').isMongoId().withMessage('Invalid sale ID'),
  ],
  getSaleById
);

router.put(
  '/:id',
  [
    auth,
    authorize('branch', 'admin'),
    query('id').isMongoId().withMessage('Invalid sale ID'),
    body('items').optional().isArray({ min: 1 }).withMessage('Items must contain at least one item'),
    body('items.*.product').optional().isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').optional().isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.unitPrice').optional().isFloat({ min: 0 }).withMessage('Unit price must be a non-negative number'),
    body('totalAmount').optional().isFloat({ min: 0 }).withMessage('Total amount must be a non-negative number'),
    body('status').optional().isIn(['completed', 'pending', 'canceled']).withMessage('Invalid status'),
    body('paymentMethod').optional().isIn(['cash', 'card', 'credit']).withMessage('Invalid payment method'),
    body('customerName').optional().trim(),
    body('customerPhone').optional().trim(),
    body('notes').optional().trim(),
  ],
  updateSale
);

router.delete(
  '/:id',
  [
    auth,
    authorize('branch', 'admin'),
    query('id').isMongoId().withMessage('Invalid sale ID'),
  ],
  deleteSale
);

router.get(
  '/export',
  [
    auth,
    authorize('admin'),
    query('branch').optional().isMongoId().withMessage('Invalid branch ID'),
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
    query('format').optional().isIn(['csv']).withMessage('Invalid format'),
  ],
  exportSalesReport
);

module.exports = router;