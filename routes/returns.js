const express = require('express');
const { body, query } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const { createReturn, approveReturn } = require('../controllers/returnController');
const mongoose = require('mongoose');

const router = express.Router();

router.post(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    body('branchId').custom(v => mongoose.isValidObjectId(v)).withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب إدخال عنصر واحد على الأقل'),
    body('items.*.product').custom(v => mongoose.isValidObjectId(v)).withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون أكبر من 0'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('سبب الإرجاع غير صالح'),
    body('items.*.reasonEn').optional().isIn(['Damaged', 'Wrong Item', 'Excess Quantity', 'Other']).withMessage('سبب الإرجاع بالإنجليزية غير صالح'),
    body('notes').optional().trim().escape(),
    body('orders').optional().isArray(),
    body('orders.*').optional().custom(v => mongoose.isValidObjectId(v)).withMessage('معرف الطلب غير صالح'),
    (req, res, next) => {
      const errors = require('express-validator').validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }
      next();
    },
  ],
  createReturn
);

router.put(
  '/:id',
  [
    auth,
    authorize('admin', 'production'),
    param('id').custom(v => mongoose.isValidObjectId(v)).withMessage('معرف الإرجاع غير صالح'),
    body('status').isIn(['approved', 'rejected']).withMessage('حالة غير صالحة'),
    body('reviewNotes').optional().trim().escape(),
    (req, res, next) => {
      const errors = require('express-validator').validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }
      next();
    },
  ],
  approveReturn
);

module.exports = router;