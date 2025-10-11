const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, param, query } = require('express-validator');
const {
  createReturn,
  approveReturn,
  getAll,
  getById,
  getBranches,
  getAvailableStock,
} = require('../controllers/returnController');
const Return = require('../models/Return');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// GET /api/returns - جلب جميع المرتجعات
router.get(
  '/',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    query('status')
      .optional()
      .isIn(['pending_approval', 'approved', 'rejected'])
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'حالة غير صالحة' : 'Invalid status'
      ),
    query('branch')
      .optional()
      .custom((value) => isValidObjectId(value))
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'
      ),
    query('search').optional().trim().escape(),
    query('sort').optional().trim().escape(),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'رقم الصفحة غير صالح' : 'Invalid page number'
      ),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'الحد غير صالح' : 'Invalid limit'
      ),
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'تاريخ البدء غير صالح' : 'Invalid start date'
      ),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'تاريخ الانتهاء غير صالح' : 'Invalid end date'
      ),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array().map((err) => ({
          field: err.param,
          message: err.msg,
          value: err.value,
        })),
      });
    }
    next();
  },
  getAll
);

// POST /api/returns - إنشاء مرتجع جديد
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('branchId')
      .custom((value) => isValidObjectId(value))
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'
      ),
    body('items')
      .isArray({ min: 1 })
      .withMessage((_, { req }) =>
        req.query.lang === 'ar'
          ? 'يجب إدخال عنصر واحد على الأقل'
          : 'At least one item is required'
      ),
    body('items.*.product')
      .custom((value) => isValidObjectId(value))
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'
      ),
    body('items.*.quantity')
      .isInt({ min: 1 })
      .withMessage((_, { req }) =>
        req.query.lang === 'ar'
          ? 'الكمية يجب أن تكون عدد صحيح إيجابي'
          : 'Quantity must be a positive integer'
      ),
    body('items.*.reason')
      .isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'])
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'سبب الإرجاع غير صالح' : 'Invalid return reason'
      ),
    body('items.*.reasonEn')
      .optional()
      .isIn(['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'])
      .withMessage((_, { req }) =>
        req.query.lang === 'ar'
          ? 'سبب الإرجاع بالإنجليزية غير صالح'
          : 'Invalid return reason in English'
      ),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array().map((err) => ({
          field: err.param,
          message: err.msg,
          value: err.value,
        })),
      });
    }
    next();
  },
  createReturn
);

// PUT /api/returns/:id - تحديث حالة المرتجع (الموافقة/الرفض)
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id')
      .custom((value) => isValidObjectId(value))
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'معرف الإرجاع غير صالح' : 'Invalid return ID'
      ),
    body('status')
      .isIn(['approved', 'rejected'])
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'حالة غير صالحة' : 'Invalid status'
      ),
    body('reviewNotes').optional().trim(),
    body('reviewNotesEn').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array().map((err) => ({
          field: err.param,
          message: err.msg,
          value: err.value,
        })),
      });
    }
    next();
  },
  approveReturn
);

// GET /api/returns/:id - جلب مرتجع محدد
router.get(
  '/:id',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    param('id')
      .custom((value) => isValidObjectId(value))
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'معرف الإرجاع غير صالح' : 'Invalid return ID'
      ),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array().map((err) => ({
          field: err.param,
          message: err.msg,
          value: err.value,
        })),
      });
    }
    next();
  },
  getById
);

// GET /api/returns/branches - جلب الفروع المتاحة
router.get(
  '/branches',
  [auth, authorize('branch', 'production', 'admin')],
  getBranches
);

// GET /api/returns/available-stock - جلب المخزون المتاح
router.get(
  '/available-stock',
  [
    auth,
    authorize('branch'),
    query('branch')
      .custom((value) => isValidObjectId(value))
      .withMessage((_, { req }) =>
        req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'
      ),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array().map((err) => ({
          field: err.param,
          message: err.msg,
          value: err.value,
        })),
      });
    }
    next();
  },
  getAvailableStock
);

module.exports = router;