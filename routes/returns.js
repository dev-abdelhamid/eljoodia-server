const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { createReturn, processReturnItems } = require('../controllers/returnsController');
const { body, query, validationResult } = require('express-validator');

router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('سبب الإرجاع غير صالح'),
    body('notes').optional().trim(),
    query('isRtl').optional().isBoolean().withMessage('isRtl يجب أن يكون قيمة منطقية'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: req.query.isRtl === 'true' ? 'خطأ في التحقق من البيانات' : 'Invalid input data',
        errors: errors.array(),
      });
    }
    createReturn(req, res);
  }
);

router.put(
  '/:returnId',
  [
    auth,
    authorize('production', 'admin'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('reviewNotes').optional().trim(),
    query('isRtl').optional().isBoolean().withMessage('isRtl يجب أن يكون قيمة منطقية'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: req.query.isRtl === 'true' ? 'خطأ في التحقق من البيانات' : 'Invalid input data',
        errors: errors.array(),
      });
    }
    processReturnItems(req, res);
  }
);

module.exports = router;