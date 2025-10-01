const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const { createReturn, approveReturn } = require('../controllers/returnController');

const router = express.Router();

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

router.get('/', [
  auth,
  authorize('branch', 'production', 'admin'),
], async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, branch, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const returns = await Return.find(query)
      .populate('order', 'orderNumber totalAmount branch')
      .populate('branch', 'name nameEn')
      .populate('items.productId', 'name nameEn price unit unitEn')
      .populate('createdBy', 'username name nameEn')
      .populate('reviewedBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    const total = await Return.countDocuments(query);

    const formattedReturns = returns.map(ret => ({
      ...ret,
      displayNotes: ret.displayNotes,
      displayReviewNotes: ret.displayReviewNotes,
      items: ret.items.map(item => ({
        ...item,
        productName: isRtl ? item.productName : (item.productNameEn || item.productName || 'Unknown'),
        unit: isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A'),
        displayReason: isRtl ? item.reason : item.reasonEn,
        displayReviewNotes: isRtl ? (item.reviewNotes || 'غير محدد') : (item.reviewNotesEn || item.reviewNotes || 'N/A'),
      })),
      createdAt: new Date(ret.createdAt).toISOString(),
      reviewedAt: ret.reviewedAt ? new Date(ret.reviewedAt).toISOString() : null,
      isRtl,
    }));

    res.status(200).json({ returns: formattedReturns, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching returns:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
});

router.post('/', [
  auth,
  authorize('branch'),
  body('orderId').isMongoId().withMessage('Invalid order ID'),
  body('branchId').isMongoId().withMessage('Invalid branch ID'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid item ID'),
  body('items.*.productId').isMongoId().withMessage('Invalid product ID'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
  body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid return reason'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
  }
  await createReturn(req, res);
});

router.put('/:id', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid return ID'),
  body('status').isIn(['approved', 'rejected']).withMessage('Invalid return status'),
  body('reviewNotes').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
  }
  await approveReturn(req, res);
});

module.exports = router;