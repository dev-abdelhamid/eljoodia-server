const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, param } = require('express-validator');
const { createReturn, approveReturn } = require('../controllers/returnController');
const Return = require('../models/Return');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع طلبات الإرجاع مع دعم التصفية والتقليب
router.get(
  '/',
  [auth, authorize(['branch', 'production', 'admin'])],
  async (req, res) => {
    try {
      const { status, branch, page = 1, limit = 10, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};

      // تصفية حسب الحالة
      if (status) query.status = status;
      
      // تصفية حسب الفرع مع التحقق من صلاحية المعرف
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      // جلب البيانات مع التصفح والترتيب
      const returns = await Return.find(query)
        .populate({
          path: 'order',
          select: 'orderNumber totalAmount branch',
          populate: { path: 'branch', select: 'name nameEn' },
        })
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

      // تنسيق البيانات حسب اللغة
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

      res.status(200).json({
        success: true,
        returns: formattedReturns,
        total,
        page: parseInt(page),
        limit: parseInt(limit),
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// جلب طلب إرجاع معين
router.get(
  '/:id',
  [auth, authorize(['branch', 'production', 'admin']), param('id').isMongoId().withMessage('معرف الإرجاع غير صالح')],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      const returnRequest = await Return.findById(id)
        .populate({
          path: 'order',
          select: 'orderNumber totalAmount branch',
          populate: { path: 'branch', select: 'name nameEn' },
        })
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
        .lean();

      if (!returnRequest) {
        console.error(`[${new Date().toISOString()}] Return not found:`, id);
        return res.status(404).json({ success: false, message: 'طلب الإرجاع غير موجود' });
      }

      if (req.user.role === 'branch' && returnRequest.branch._id.toString() !== req.user.branchId?.toString()) {
        console.error(`[${new Date().toISOString()}] Unauthorized access:`, {
          userId: req.user.id,
          branchId: returnRequest.branch._id,
          userBranchId: req.user.branchId,
        });
        return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى طلب الإرجاع لهذا الفرع' });
      }

      const formattedReturn = {
        ...returnRequest,
        branchName: isRtl ? returnRequest.branch?.name : returnRequest.branch?.nameEn || returnRequest.branch?.name,
        reason: isRtl ? returnRequest.reason : returnRequest.reasonEn,
        items: returnRequest.items.map((item) => ({
          ...item,
          productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          departmentName: isRtl
            ? item.product?.department?.name
            : item.product?.department?.nameEn || item.product?.department?.name,
          reason: isRtl ? item.reason : item.reasonEn,
        })),
        createdByName: isRtl ? returnRequest.createdBy?.name : returnRequest.createdBy?.nameEn || returnRequest.createdBy?.name,
        reviewedByName: isRtl
          ? returnRequest.reviewedBy?.name
          : returnRequest.reviewedBy?.nameEn || returnRequest.reviewedBy?.name,
      };

      res.status(200).json({ success: true, returnRequest: formattedReturn });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching return:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// إنشاء طلب إرجاع
router.post(
  '/',
  [
    auth,
    authorize(['branch']),
    body('orderId').optional().isMongoId().withMessage('معرف الطلب غير صالح'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('سبب الإرجاع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').optional().isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('سبب الإرجاع للعنصر غير صالح'),
    body('notes').optional().trim().isString().withMessage('الملاحظات يجب أن تكون نصًا'),
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
    authorize(['production', 'admin']),
    param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('reviewNotes').optional().trim().isString().withMessage('ملاحظات المراجعة يجب أن تكون نصًا'),
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