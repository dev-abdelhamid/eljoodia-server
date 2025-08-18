const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع طلبات الإرجاع
router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  async (req, res) => {
    try {
      console.log('User accessing /api/returns:', req.user); // تسجيل للتحقق من الصلاحيات
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
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { orderId, branchId, reason, items, notes } = req.body;

      const order = await Order.findById(orderId).populate('items.product');
      if (!order) {
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب مسلمًا لإنشاء إرجاع' });
      }
      if (order.branch.toString() !== branchId || (req.user.role === 'branch' && branchId !== req.user.branchId.toString())) {
        return res.status(403).json({ success: false, message: 'غير مخول لإنشاء إرجاع لهذا الطلب' });
      }

      // التحقق من أن الطلب لا يزيد عمره عن 3 أيام
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      if (new Date(order.createdAt) < threeDaysAgo) {
        return res.status(400).json({ success: false, message: 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' });
      }

      // التحقق من العناصر
      for (const item of items) {
        const orderItem = order.items.find((i) => i.product._id.toString() === item.product);
        if (!orderItem) {
          return res.status(400).json({ success: false, message: `المنتج ${item.product} غير موجود في الطلب` });
        }
        if (item.quantity > orderItem.quantity) {
          return res.status(400).json({ success: false, message: `كمية الإرجاع للمنتج ${item.product} تتجاوز الكمية المطلوبة` });
        }
      }

      // إنشاء رقم الإرجاع
      const returnCount = await Return.countDocuments();
      const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

      // إنشاء طلب الإرجاع
      const newReturn = new Return({
        returnNumber,
        order: orderId,
        branch: branchId,
        reason,
        items: items.map((item) => ({
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
        })),
        status: 'pending',
        createdBy: req.user.id,
        notes: notes?.trim(),
      });

      await newReturn.save();

      // تحديث الطلب بإضافة الإرجاع
      order.returns = order.returns || [];
      order.returns.push({
        _id: newReturn._id,
        returnNumber,
        status: 'pending',
        items: items.map((item) => ({
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
        })),
        reason,
        createdAt: new Date(),
      });
      await order.save();

      // ملء البيانات
      const populatedReturn = await Return.findById(newReturn._id)
        .populate('order', 'orderNumber totalAmount branch')
        .populate('items.product', 'name price')
        .populate('branch', 'name')
        .populate('createdBy', 'username')
        .lean();

      // إرسال حدث Socket.IO
      req.io?.emit('returnCreated', {
        returnId: newReturn._id,
        branchId,
        orderId,
        returnNumber,
        status: 'pending',
        reason,
        returnItems: items,
        createdAt: newReturn.createdAt,
      });

      res.status(201).json(populatedReturn);
    } catch (err) {
      console.error('خطأ في إنشاء الإرجاع:', err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// الموافقة على طلب إرجاع
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    body('status').isIn(['approved', 'rejected']).withMessage('الحالة يجب أن تكون إما موافق عليه أو مرفوض'),
    body('reviewNotes').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { id } = req.params;
      const { status, reviewNotes } = req.body;

      const returnDoc = await Return.findById(id).populate('order items.product');
      if (!returnDoc) {
        return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
      }

      const order = await Order.findById(returnDoc.order._id);
      if (!order) {
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }

      let returnTotal = 0;
      if (status === 'approved') {
        // حساب إجمالي المرتجع
        for (const returnItem of returnDoc.items) {
          const orderItem = order.items.find(
            (item) => item.product.toString() === returnItem.product.toString()
          );
          if (orderItem) {
            returnTotal += orderItem.price * returnItem.quantity;
          }
        }

        // تحديث إجمالي الطلب والملاحظات
        order.totalAmount -= returnTotal;
        if (order.totalAmount < 0) order.totalAmount = 0;
        const returnNote = `إرجاع مقبول (${returnDoc.returnNumber}) بقيمة ${returnTotal} ريال`;
        order.notes = order.notes ? `${order.notes}\n${returnNote}` : returnNote;
        order.returns = order.returns.map((r) =>
          r._id.toString() === id ? { ...r, status, reviewNotes } : r
        );
        await order.save();

        // إنشاء حركة مخزون
        for (const item of returnDoc.items) {
          await Inventory.findOneAndUpdate(
            { branch: returnDoc.branch, product: item.product },
            {
              $inc: { currentStock: item.quantity }, // إعادة الكمية إلى المخزون
              $push: {
                movements: {
                  type: 'return_approved',
                  quantity: item.quantity,
                  reference: returnDoc.returnNumber,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, upsert: true }
          );
        }
      }

      // تحديث حالة الإرجاع
      returnDoc.status = status;
      returnDoc.reviewedBy = req.user.id;
      returnDoc.reviewedAt = new Date();
      returnDoc.reviewNotes = reviewNotes?.trim();
      returnDoc.statusHistory = returnDoc.statusHistory || [];
      returnDoc.statusHistory.push({
        status,
        changedBy: req.user.id,
        notes: reviewNotes,
        changedAt: new Date(),
      });
      await returnDoc.save();

      // ملء البيانات
      const populatedReturn = await Return.findById(id)
        .populate('order', 'orderNumber totalAmount branch')
        .populate('items.product', 'name price')
        .populate('branch', 'name')
        .populate('createdBy', 'username')
        .populate('reviewedBy', 'username')
        .lean();

      // إرسال حدث Socket.IO
      req.io?.emit('returnStatusUpdated', {
        returnId: id,
        orderId: returnDoc.order._id,
        branchId: returnDoc.branch,
        status,
        returnTotal: status === 'approved' ? returnTotal : 0,
        returnNote: status === 'approved' ? `إرجاع مقبول (${returnDoc.returnNumber})` : undefined,
      });

      res.status(200).json(populatedReturn);
    } catch (err) {
      console.error('خطأ في معالجة الإرجاع:', err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

module.exports = router;