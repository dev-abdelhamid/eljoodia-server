const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, query, validationResult } = require('express-validator');
const { createReturn, approveReturn } = require('../controllers/returnController');
const Return = require('../models/Return');

router.get(
  '/',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1 }).withMessage('Limit must be a positive integer'),
    query('status').optional().isIn(['pending', 'approved', 'rejected']).withMessage('Invalid status'),
    query('branch').optional().isMongoId().withMessage('Invalid branch ID'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
      }

      const { status, branch, page = 1, limit = 10, isRtl = true } = req.query;
      const query = {};
      if (status) query.status = status;
      if (branch) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate('order', 'orderNumber totalAmount adjustedTotal')
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .populate('createdBy', 'username')
        .populate('reviewedBy', 'username')
        .setOptions({ context: { isRtl } })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const total = await Return.countDocuments(query);

      res.status(200).json({
        returns: returns.map(ret => ({
          ...ret,
          displayReason: ret.displayReason,
          items: ret.items.map(item => ({
            ...item,
            displayReason: item.displayReason,
          })),
          isRtl,
        })),
        total,
      });
    } catch (err) {
      console.error('Error fetching returns:', err);
      res.status(500).json({ success: false, message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').isMongoId().withMessage('Invalid order ID'),
    body('branchId').isMongoId().withMessage('Invalid branch ID'),
    body('reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid reason'),
    body('items').isArray({ min: 1 }).withMessage('Items array must contain at least one item'),
    body('items.*.product').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid item reason'),
    body('notes').optional().trim(),
  ],
  createReturn
);

router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    body('status').isIn(['approved', 'rejected']).withMessage('Status must be approved or rejected'),
    body('reviewNotes').optional().trim(),
  ],
  approveReturn
);

module.exports = router;