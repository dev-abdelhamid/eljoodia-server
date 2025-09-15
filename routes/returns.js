const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const { createReturn, approveReturn } = require('./returns');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  async (req, res) => {
    try {
      console.log('User accessing /api/returns:', req.user);
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
      console.error('Error fetching returns:', err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').isIn(['defective', 'wrong_item', 'other']).withMessage('سبب الإرجاع غير صالح'),
  ],
  createReturn
);

router.patch(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر غير صالحة'),
    body('items.*.reviewNotes').optional().trim(),
    body('reviewNotes').optional().trim(),
  ],
  approveReturn
);

module.exports = router;