const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, param, query } = require('express-validator');
const { createReturn, approveReturn } = require('../controllers/returnController');
const Return = require('../models/Return');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Fetch all returns
router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  async (req, res) => {
    try {
      const { status, branch, page = 1, limit = 10, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};
      if (status) query.status = status;
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate({
          path: 'orders',
          select: 'orderNumber',
        })
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const total = await Return.countDocuments(query);

      const formattedReturns = returns.map((ret) => ({
        ...ret,
        branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn || ret.branch?.name,
        items: ret.items.map((item) => ({
          ...item,
          productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name,
          reason: isRtl ? item.reason : item.reasonEn || item.reason,
        })),
        createdByName: isRtl ? ret.createdBy?.name : ret.createdBy?.nameEn || ret.createdBy?.name,
        reviewedByName: isRtl ? ret.reviewedBy?.name : ret.reviewedBy?.nameEn || ret.reviewedBy?.name,
      }));

      res.status(200).json({ returns: formattedReturns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns:`, err);
      res.status(500).json({ success: false, message: 'Server error', error: err.message });
    }
  }
);

// Create a return
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orders').optional().isArray().withMessage('Orders must be an array'),
    body('orders.*').isMongoId().withMessage('Invalid order ID'),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid item reason'),
    body('items.*.reasonEn').optional().isString().withMessage('English reason must be a string'),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }
    next();
  },
  createReturn
);

// Approve or reject a return
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('Invalid return ID'),
    body('status').isIn(['approved', 'rejected']).withMessage('Status must be either approved or rejected'),
    body('reviewNotes').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }
    next();
  },
  approveReturn
);

module.exports = router;