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
  [
    auth,
    authorize('branch', 'production', 'admin'),
    query('branch').optional().custom(isValidObjectId).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    query('status').optional().isIn(['pending_approval', 'approved', 'rejected']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'حالة غير صالحة' : 'Invalid status'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1 }).toInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }

    try {
      const { status, branch, page = 1, limit = 10, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};
      if (status) query.status = status;
      if (branch) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate({
          path: 'orders',
          select: 'orderNumber',
        })
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
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
        branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn || ret.branch?.name || 'Unknown',
        items: ret.items.map((item) => ({
          ...item,
          productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name || 'Unknown',
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name || 'Unknown',
          reason: isRtl ? item.reason : item.reasonEn || item.reason,
        })),
        createdByName: isRtl ? ret.createdBy?.name : ret.createdBy?.nameEn || ret.createdBy?.name || 'Unknown',
        reviewedByName: isRtl ? ret.reviewedBy?.name : ret.reviewedBy?.nameEn || ret.reviewedBy?.name || 'Unknown',
      }));

      console.log(`[${new Date().toISOString()}] جلب المرتجعات - تم بنجاح:`, {
        branchId: query.branch,
        status,
        page,
        limit,
        total,
      });

      res.status(200).json({ success: true, returns: formattedReturns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] خطأ في جلب المرتجعات:`, {
        error: err.message,
        stack: err.stack,
        query: req.query,
      });
      res.status(500).json({
        success: false,
        message: req.query.lang === 'ar' ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
    }
  }
);

// Create a return
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('branchId').custom(isValidObjectId).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    body('orders').optional().isArray().withMessage((_, { req }) => req.query.lang === 'ar' ? 'الطلبات يجب أن تكون مصفوفة' : 'Orders must be an array'),
    body('orders.*').custom(isValidObjectId).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الطلب غير صالح' : 'Invalid order ID'),
    body('items').isArray({ min: 1 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'يجب إدخال عنصر واحد على الأقل' : 'At least one item is required'),
    body('items.*.product').custom(isValidObjectId).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الكمية يجب أن تكون عدد صحيح إيجابي' : 'Quantity must be a positive integer'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع غير صالح' : 'Invalid return reason'),
    body('items.*.reasonEn').isIn(['Damaged', 'Wrong Item', 'Excess Quantity', 'Other']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع بالإنجليزية غير صالح' : 'Invalid English return reason'),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
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
    param('id').custom(isValidObjectId).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الإرجاع غير صالح' : 'Invalid return ID'),
    body('status').isIn(['approved', 'rejected']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحالة يجب أن تكون إما موافق عليها أو مرفوضة' : 'Status must be either approved or rejected'),
    body('reviewNotes').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }
    next();
  },
  approveReturn
);

module.exports = router;