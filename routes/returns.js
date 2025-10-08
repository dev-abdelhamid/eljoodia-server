// routes/returns.js
const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, param, query } = require('express-validator');
const { createReturn, approveReturn } = require('../controllers/returnController');
const Return = require('../models/Return');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع طلبات الإرجاع
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
          path: 'order',
          select: 'orderNumber totalAmount branch',
          populate: { path: 'branch', select: 'name nameEn' },
        })
        .populate('orders', 'orderNumber')
        .populate({
          path: 'branch',
          select: 'name nameEn',
        })
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .setOptions({ context: { isRtl } })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const total = await Return.countDocuments(query);

      const formattedReturns = returns.map((ret) => ({
        ...ret,
        branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn || ret.branch?.name,
        reason: isRtl ? ret.reason : ret.reasonEn,
        items: ret.items.map((item) => ({
          ...item,
          productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name,
          reason: isRtl ? item.reason : item.reasonEn,
        })),
        createdByName: isRtl ? ret.createdBy?.name : ret.createdBy?.nameEn || ret.createdBy?.name,
        reviewedByName: isRtl ? ret.reviewedBy?.name : ret.reviewedBy?.nameEn || ret.reviewedBy?.name,
      }));

      res.status(200).json({ returns: formattedReturns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns:`, err);
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
    body('orderId').optional().isMongoId().withMessage('معرف الطلب غير صالح'),
    body('orders').optional().isArray().withMessage('الطلبات يجب أن تكون مصفوفة'),
    body('orders.*').isMongoId().withMessage('معرف طلب غير صالح'),
    body('reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('سبب الإرجاع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.order').optional().isMongoId().withMessage('معرف الطلب للعنصر غير صالح'),
    body('items.*.itemId').optional().isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('سبب الإرجاع للعنصر غير صالح'),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
    }
    next();
  },
  createReturn
);

// الموافقة على طلب إرجاع
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('reviewNotes').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
    }
    next();
  },
  approveReturn
);

module.exports = router;