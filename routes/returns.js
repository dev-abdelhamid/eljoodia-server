const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
};

// جلب جميع طلبات الإرجاع
router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  async (req, res) => {
    try {
      console.log(`[${new Date().toISOString()}] User accessing /api/returns:`, req.user);
      const { status, branch, page = 1, limit = 10 } = req.query;
      const isRtl = req.headers['x-language'] !== 'en';
      const query = {};
      if (status) query.status = status;
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate('order', 'orderNumber totalAmount branch createdAt')
        .populate({
          path: 'branch',
          select: 'name nameEn',
          options: { context: { isRtl } },
        })
        .populate({
          path: 'items.product',
          select: 'name nameEn price unit unitEn',
          options: { context: { isRtl } },
        })
        .populate('createdBy', 'username')
        .populate('reviewedBy', 'username')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      // تخصيص البيانات بناءً على اللغة
      const formattedReturns = returns.map((ret) => ({
        ...ret,
        branch: {
          _id: ret.branch._id,
          name: isRtl ? ret.branch.name : (ret.branch.nameEn || ret.branch.name),
        },
        items: ret.items.map((item) => ({
          ...item,
          product: {
            _id: item.product._id,
            name: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
            price: item.product.price,
            unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit),
          },
          reason: isRtl ? item.reason : item.reasonEn,
        })),
        reason: isRtl ? ret.reason : ret.reasonEn,
      }));

      const total = await Return.countDocuments(query);

      res.status(200).json({ returns: formattedReturns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns:`, err);
      res.status(500).json({
        success: false,
        message: isRtl ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
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
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').notEmpty().withMessage('سبب الإرجاع للعنصر مطلوب'),
    body('notes').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      const isRtl = req.headers['x-language'] !== 'en';
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const { orderId, branchId, reason, items, notes } = req.body;

      const order = await Order.findById(orderId).populate('items.product');
      if (!order) {
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        });
      }
      if (order.status !== 'delivered') {
        return res.status(400).json({
          success: false,
          message: isRtl ? 'يجب أن يكون الطلب مسلمًا لإنشاء إرجاع' : 'Order must be delivered to create a return',
        });
      }
      if (order.branch.toString() !== branchId || (req.user.role === 'branch' && branchId !== req.user.branchId.toString())) {
        return res.status(403).json({
          success: false,
          message: isRtl ? 'غير مخول لإنشاء إرجاع لهذا الطلب' : 'Unauthorized to create return for this order',
        });
      }

      // التحقق من أن الطلب لا يزيد عمره عن 3 أيام
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      if (new Date(order.createdAt) < threeDaysAgo) {
        return res.status(400).json({
          success: false,
          message: isRtl ? 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' : 'Cannot create return for order older than 3 days',
        });
      }

      // التحقق من العناصر
      for (const item of items) {
        const orderItem = order.items.find((i) => i._id.toString() === item.itemId && i.product._id.toString() === item.productId);
        if (!orderItem) {
          return res.status(400).json({
            success: false,
            message: isRtl ? `العنصر ${item.itemId} غير موجود في الطلب` : `Item ${item.itemId} not found in order`,
          });
        }
        const returnedQuantity = orderItem.returnedQuantity || 0;
        const availableQuantity = orderItem.quantity - returnedQuantity;
        if (item.quantity > availableQuantity) {
          return res.status(400).json({
            success: false,
            message: isRtl
              ? `كمية الإرجاع للمنتج ${item.productId} تتجاوز الكمية المتاحة`
              : `Return quantity for product ${item.productId} exceeds available quantity`,
          });
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
          itemId: item.itemId,
          product: item.productId,
          quantity: item.quantity,
          reason: item.reason,
        })),
        status: 'pending_approval',
        createdBy: req.user.id,
        notes: notes?.trim(),
      });

      await newReturn.save();

      // تحديث الطلب بإضافة الإرجاع وتتبع الكميات المرتجعة
      order.items = order.items.map((orderItem) => {
        const returnItem = items.find((item) => item.itemId === orderItem._id.toString());
        if (returnItem) {
          orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        }
        return orderItem;
      });
      order.returns = order.returns || [];
      order.returns.push({
        _id: newReturn._id,
        returnNumber,
        status: 'pending_approval',
        items: items.map((item) => ({
          itemId: item.itemId,
          product: item.productId,
          quantity: item.quantity,
          reason: item.reason,
        })),
        reason,
        createdAt: new Date(),
      });
      await order.save();

      // ملء البيانات
      const populatedReturn = await Return.findById(newReturn._id)
        .populate('order', 'orderNumber totalAmount branch createdAt')
        .populate({
          path: 'branch',
          select: 'name nameEn',
          options: { context: { isRtl } },
        })
        .populate({
          path: 'items.product',
          select: 'name nameEn price unit unitEn',
          options: { context: { isRtl } },
        })
        .populate('createdBy', 'username')
        .lean();

      // تخصيص البيانات بناءً على اللغة
      const formattedReturn = {
        ...populatedReturn,
        branch: {
          _id: populatedReturn.branch._id,
          name: isRtl ? populatedReturn.branch.name : (populatedReturn.branch.nameEn || populatedReturn.branch.name),
        },
        items: populatedReturn.items.map((item) => ({
          ...item,
          product: {
            _id: item.product._id,
            name: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
            price: item.product.price,
            unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit),
          },
          reason: isRtl ? item.reason : item.reasonEn,
        })),
        reason: isRtl ? populatedReturn.reason : populatedReturn.reasonEn,
      };

      // إرسال حدث Socket.IO
      req.io?.emit('returnCreated', {
        returnId: newReturn._id,
        branchId,
        orderId,
        returnNumber,
        status: 'pending_approval',
        reason: isRtl ? reason : returnReasonMapping[reason] || reason,
        returnItems: items.map((item) => ({
          itemId: item.itemId,
          productId: item.productId,
          quantity: item.quantity,
          reason: isRtl ? item.reason : returnReasonMapping[item.reason] || item.reason,
        })),
        createdAt: newReturn.createdAt,
        notes,
      });

      res.status(201).json(formattedReturn);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error creating return:`, err);
      res.status(500).json({
        success: false,
        message: isRtl ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
    }
  }
);

// تحديث حالة طلب الإرجاع
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
      const isRtl = req.headers['x-language'] !== 'en';
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const { id } = req.params;
      const { status, reviewNotes } = req.body;

      const returnDoc = await Return.findById(id).populate('order items.product');
      if (!returnDoc) {
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الإرجاع غير موجود' : 'Return not found',
        });
      }

      const order = await Order.findById(returnDoc.order._id);
      if (!order) {
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        });
      }

      let returnTotal = 0;
      if (status === 'approved') {
        // حساب إجمالي المرتجع
        for (const returnItem of returnDoc.items) {
          const orderItem = order.items.find(
            (item) => item._id.toString() === returnItem.itemId.toString()
          );
          if (orderItem) {
            returnTotal += orderItem.price * returnItem.quantity;
          }
        }

        // تحديث إجمالي الطلب والملاحظات
        order.totalAmount -= returnTotal;
        if (order.totalAmount < 0) order.totalAmount = 0;
        const returnNote = isRtl
          ? `إرجاع مقبول (${returnDoc.returnNumber}) بقيمة ${returnTotal} ريال`
          : `Return approved (${returnDoc.returnNumber}) with value ${returnTotal} SAR`;
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
              $inc: { currentStock: item.quantity },
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
        .populate('order', 'orderNumber totalAmount branch createdAt')
        .populate({
          path: 'branch',
          select: 'name nameEn',
          options: { context: { isRtl } },
        })
        .populate({
          path: 'items.product',
          select: 'name nameEn price unit unitEn',
          options: { context: { isRtl } },
        })
        .populate('createdBy', 'username')
        .populate('reviewedBy', 'username')
        .lean();

      // تخصيص البيانات بناءً على اللغة
      const formattedReturn = {
        ...populatedReturn,
        branch: {
          _id: populatedReturn.branch._id,
          name: isRtl ? populatedReturn.branch.name : (populatedReturn.branch.nameEn || populatedReturn.branch.name),
        },
        items: populatedReturn.items.map((item) => ({
          ...item,
          product: {
            _id: item.product._id,
            name: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
            price: item.product.price,
            unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit),
          },
          reason: isRtl ? item.reason : item.reasonEn,
        })),
        reason: isRtl ? populatedReturn.reason : populatedReturn.reasonEn,
      };

      // إرسال حدث Socket.IO
      req.io?.emit('returnStatusUpdated', {
        returnId: id,
        orderId: returnDoc.order._id,
        branchId: returnDoc.branch,
        status,
        returnTotal: status === 'approved' ? returnTotal : 0,
        returnNote: status === 'approved' ? (isRtl ? `إرجاع مقبول (${returnDoc.returnNumber})` : `Return approved (${returnDoc.returnNumber})`) : undefined,
        reviewNotes,
      });

      res.status(200).json(formattedReturn);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error updating return:`, err);
      res.status(500).json({
        success: false,
        message: isRtl ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
    }
  }
);

module.exports = router;