const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, query, param, validationResult } = require('express-validator');
const { createReturn, approveReturn, getReturns } = require('../controllers/returnController');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع طلبات الإرجاع
router.get(
  '/',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1 }).withMessage('Limit must be a positive integer'),
    query('status').optional().isIn(['pending', 'approved', 'rejected']).withMessage('Invalid status'),
    query('branch').optional().custom(isValidObjectId).withMessage('Invalid branch ID'),
    query('search').optional().isLength({ max: 100 }).withMessage('Search query too long'),
    query('sortBy').optional().isIn(['createdAt', 'returnNumber', 'status']).withMessage('Invalid sortBy field'),
    query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('Invalid sortOrder'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  getReturns
);

// جلب طلب إرجاع واحد
router.get(
  '/:id',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    param('id').custom(isValidObjectId).withMessage('Invalid return ID'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: req.query.isRtl === 'true' ? 'خطأ في التحقق من البيانات' : 'Validation error', 
          errors: errors.array() 
        });
      }

      const isRtl = req.query.isRtl === 'true';
      const { id } = req.params;

      const returnDoc = await Return.findById(id)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch notes notesEn')
        .populate('branch', 'name nameEn')
        .populate('items.product', 'name nameEn price unit unitEn department')
        .populate({ path: 'items.product.department', select: 'name nameEn' })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .setOptions({ context: { isRtl } })
        .lean();

      if (!returnDoc) {
        return res.status(404).json({ 
          success: false, 
          message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' 
        });
      }

      res.status(200).json({
        ...returnDoc,
        displayReason: returnDoc.displayReason,
        items: returnDoc.items.map(item => ({
          ...item,
          displayReason: item.displayReason,
          product: {
            ...item.product,
            displayName: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            displayUnit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
          },
        })),
        branch: {
          ...returnDoc.branch,
          displayName: getDisplayName(returnDoc.branch?.name, returnDoc.branch?.nameEn, isRtl),
        },
        order: {
          ...returnDoc.order,
          displayNotes: returnDoc.order.displayNotes,
          branch: {
            ...returnDoc.order.branch,
            displayName: getDisplayName(returnDoc.order.branch?.name, returnDoc.order.branch?.nameEn, isRtl),
          },
        },
        createdBy: {
          ...returnDoc.createdBy,
          displayName: getDisplayName(returnDoc.createdBy?.name, returnDoc.createdBy?.nameEn, isRtl),
        },
        reviewedBy: returnDoc.reviewedBy
          ? {
              ...returnDoc.reviewedBy,
              displayName: getDisplayName(returnDoc.reviewedBy.name, returnDoc.reviewedBy.nameEn, isRtl),
            }
          : undefined,
        isRtl,
      });
    } catch (err) {
      console.error('Error fetching return:', err);
      res.status(500).json({ 
        success: false, 
        message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error', 
        error: err.message 
      });
    }
  }
);

// إنشاء طلب إرجاع
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').custom(isValidObjectId).withMessage('Invalid order ID'),
    body('branchId').custom(isValidObjectId).withMessage('Invalid branch ID'),
    body('reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid reason'),
    body('items').isArray({ min: 1 }).withMessage('Items array must contain at least one item'),
    body('items.*.product').custom(isValidObjectId).withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid item reason'),
    body('notes').optional().trim().isLength({ max: 500 }).withMessage('Notes too long'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  createReturn
);

// الموافقة على طلب إرجاع
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id').custom(isValidObjectId).withMessage('Invalid return ID'),
    body('status').isIn(['approved', 'rejected']).withMessage('Status must be approved or rejected'),
    body('reviewNotes').optional().trim().isLength({ max: 500 }).withMessage('Review notes too long'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  approveReturn
);

module.exports = router;