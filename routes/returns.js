const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const returnController = require('../controllers/returnController');

// تسجيل المسارات لتصحيح الأخطاء
router.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Route accessed: ${req.method} ${req.originalUrl}`);
  next();
});

// جلب جميع طلبات الإرجاع
router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  returnController.getAllReturns
);

// إنشاء طلب إرجاع
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('reason').notEmpty().withMessage('السبب مطلوب'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').notEmpty().withMessage('سبب الإرجاع للعنصر مطلوب'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
    }
    return returnController.createReturn(req, res);
  }
);

// تحديث حالة الإرجاع (PUT)
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('reviewNotes').optional().trim(),
    body('items').isArray({ min: 1 }).withMessage('يجب توفير حالة لجميع العناصر'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون إما موافق عليه أو مرفوض'),
    body('items.*.reviewNotes').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
    }
    return returnController.updateReturnStatus(req, res);
  }
);

// تحديث حالة الإرجاع (PATCH)
router.patch(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('reviewNotes').optional().trim(),
    body('items').isArray({ min: 1 }).withMessage('يجب توفير حالة لجميع العناصر'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون إما موافق عليه أو مرفوض'),
    body('items.*.reviewNotes').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
    }
    return returnController.updateReturnStatus(req, res);
  }
);

module.exports = router;