const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, param } = require('express-validator');
const { createReturn, approveReturn, processReturn } = require('../controllers/orderController');
const Return = require('../models/Return');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع طلبات الإرجاع
router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  async (req, res) => {
    try {
      const { status, branch, page = 1, limit = 10 } = req.query;
      const query = {};
      if (status) query.status = status;
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate('order', 'orderNumber totalAmount')
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .populate('createdBy', 'username')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const total = await Return.countDocuments(query);

      res.status(200).json({ returns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns: ${err.message}, User: ${req.user.id}`);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// إنشاء طلب إرجاع
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('reason').notEmpty().withMessage('السبب مطلوب'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').isIn(['defective', 'wrong_item', 'other']).withMessage('سبب الإرجاع للعنصر غير صالح'),
    body('notes').optional().trim(),
  ],
  createReturn
);

// الموافقة على طلب إرجاع (الكلي)
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('reviewNotes').optional().trim(),
  ],
  approveReturn
);

// معالجة طلب إرجاع (لكل عنصر)
router.patch(
  '/:id/process',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون إما موافق عليه أو مرفوض'),
    body('items.*.reviewNotes').optional().trim(),
    body('reviewNotes').optional().trim(),
  ],
  processReturn
);

module.exports = router;