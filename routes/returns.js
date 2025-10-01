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

      // تحويل البيانات إلى الشكل المناسب حسب اللغة
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
    body('orderId').isMongoId().withMessage('معرف الطلب غير صالح'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('reason').notEmpty().withMessage('السبب مطلوب'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').notEmpty().withMessage('سبب الإرجاع للعنصر مطلوب'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { orderId, branchId, reason, items, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      const order = await Order.findById(orderId).populate('items.product').session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب مسلمًا لإنشاء إرجاع' });
      }
      if (order.branch.toString() !== branchId || (req.user.role === 'branch' && branchId !== req.user.branchId.toString())) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: 'غير مخول لإنشاء إرجاع لهذا الطلب' });
      }

      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      if (new Date(order.createdAt) < threeDaysAgo) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' });
      }

      for (const item of items) {
        const orderItem = order.items.find((i) => i.product._id.toString() === item.product);
        if (!orderItem) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: `المنتج ${item.product} غير موجود في الطلب` });
        }
        if (item.quantity > orderItem.quantity) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: `كمية الإرجاع للمنتج ${item.product} تتجاوز الكمية المطلوبة` });
        }
      }

      const returnCount = await Return.countDocuments().session(session);
      const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

      const newReturn = new Return({
        returnNumber,
        order: orderId,
        branch: branchId,
        reason,
        items: items.map((item) => ({
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
          itemId: item.itemId,
        })),
        status: 'pending_approval',
        createdBy: req.user.id,
        notes: notes?.trim(),
      });

      await newReturn.save({ session });

      order.returns = order.returns || [];
      order.returns.push({
        _id: newReturn._id,
        returnNumber,
        status: 'pending_approval',
        items: items.map((item) => ({
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
          itemId: item.itemId,
        })),
        reason,
        createdAt: new Date(),
      });
      await order.save({ session });

      const populatedReturn = await Return.findById(newReturn._id)
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
        .setOptions({ context: { isRtl } })
        .lean();

      // تحويل البيانات إلى الشكل المناسب حسب اللغة
      const formattedReturn = {
        ...populatedReturn,
        branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn || populatedReturn.branch?.name,
        reason: isRtl ? populatedReturn.reason : populatedReturn.reasonEn,
        items: populatedReturn.items.map((item) => ({
          ...item,
          productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name,
          reason: isRtl ? item.reason : item.reasonEn,
        })),
        createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name,
      };

      req.io?.emit('returnCreated', {
        returnId: newReturn._id,
        branchId,
        orderId,
        returnNumber,
        status: 'pending_approval',
        reason,
        returnItems: formattedReturn.items,
        createdAt: newReturn.createdAt,
      });

      await session.commitTransaction();
      res.status(201).json(formattedReturn);
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error creating return:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
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
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { id } = req.params;
      const { status, reviewNotes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      const returnDoc = await Return.findById(id)
        .populate({
          path: 'order',
          select: 'orderNumber totalAmount branch items',
          populate: { path: 'branch', select: 'name nameEn' },
        })
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .session(session);

      if (!returnDoc) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
      }

      const order = await Order.findById(returnDoc.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }

      let returnTotal = 0;
      if (status === 'approved') {
        for (const returnItem of returnDoc.items) {
          const orderItem = order.items.find(
            (item) => item.product.toString() === returnItem.product.toString()
          );
          if (orderItem) {
            returnTotal += orderItem.price * returnItem.quantity;
          }
        }

        order.totalAmount -= returnTotal;
        if (order.totalAmount < 0) order.totalAmount = 0;
        const returnNote = `إرجاع مقبول (${returnDoc.returnNumber}) بقيمة ${returnTotal} ريال`;
        order.notes = order.notes ? `${order.notes}\n${returnNote}` : returnNote;
        order.returns = order.returns.map((r) =>
          r._id.toString() === id ? { ...r, status, reviewNotes } : r
        );
        await order.save({ session });

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
            { new: true, upsert: true, session }
          );
        }
      } else if (status === 'rejected') {
        for (const item of returnDoc.items) {
          await Inventory.findOneAndUpdate(
            { branch: returnDoc.branch, product: item.product },
            {
              $inc: { currentStock: item.quantity },
              $push: {
                movements: {
                  type: 'return_rejected',
                  quantity: item.quantity,
                  reference: `رفض إرجاع #${returnDoc.returnNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, session }
          );
        }
      }

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
      await returnDoc.save({ session });

      const populatedReturn = await Return.findById(id)
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
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .setOptions({ context: { isRtl } })
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn || populatedReturn.branch?.name,
        reason: isRtl ? populatedReturn.reason : populatedReturn.reasonEn,
        items: populatedReturn.items.map((item) => ({
          ...item,
          productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name,
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name,
          reason: isRtl ? item.reason : item.reasonEn,
        })),
        createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name,
        reviewedByName: isRtl ? populatedReturn.reviewedBy?.name : populatedReturn.reviewedBy?.nameEn || populatedReturn.reviewedBy?.name,
      };

      req.io?.emit('returnStatusUpdated', {
        returnId: id,
        orderId: returnDoc.order._id,
        branchId: returnDoc.branch,
        status,
        returnTotal: status === 'approved' ? returnTotal : 0,
        returnNote: status === 'approved' ? `إرجاع مقبول (${returnDoc.returnNumber})` : undefined,
        items: formattedReturn.items,
      });

      await session.commitTransaction();
      res.status(200).json(formattedReturn);
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error approving return:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;