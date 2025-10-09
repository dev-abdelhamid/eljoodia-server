const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, param, query } = require('express-validator');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const { updateInventoryStock } = require('../utils/inventoryUtils');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب كل طلبات الإرجاع
router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  async (req, res) => {
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';
    try {
      const { status, branch, page = 1, limit = 10 } = req.query;
      const query = {};
      if (status) query.status = status;
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const total = await Return.countDocuments(query);

      const formattedReturns = returns.map((ret) => ({
        ...ret,
        branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn || ret.branch?.name || 'غير معروف',
        items: ret.items.map((item) => ({
          ...item,
          productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name || 'غير معروف',
          unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
          departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف',
          reason: isRtl ? item.reason : item.reasonEn || item.reason,
        })),
        createdByName: isRtl ? ret.createdBy?.name : ret.createdBy?.nameEn || ret.createdBy?.name || 'غير معروف',
        reviewedByName: isRtl ? ret.reviewedBy?.name : ret.reviewedBy?.nameEn || ret.reviewedBy?.name || 'غير معروف',
      }));

      res.status(200).json({ success: true, returns: formattedReturns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] خطأ في جلب طلبات الإرجاع:`, {
        message: err.message,
        stack: err.stack,
        query: req.query,
      });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// إنشاء طلب إرجاع جديد
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('branchId').isMongoId().withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    body('items').isArray({ min: 1 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'يجب إدخال عنصر واحد على الأقل' : 'At least one item is required'),
    body('items.*.product').isMongoId().withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الكمية يجب أن تكون عدد صحيح إيجابي' : 'Quantity must be a positive integer'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع غير صالح' : 'Invalid return reason'),
    body('items.*.reasonEn').isIn(['Damaged', 'Wrong Item', 'Excess Quantity', 'Other']).optional().withMessage((_, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع بالإنجليزية غير صالح' : 'Invalid English return reason'),
    body('items.*.price').isFloat({ min: 0 }).optional().withMessage((_, { req }) => req.query.lang === 'ar' ? 'السعر يجب أن يكون غير سالب' : 'Price must be non-negative'),
    body('notes').optional().trim(),
  ],
  async (req, res) => {
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';
    const session = await mongoose.startSession({ defaultTransactionOptions: { maxTimeMS: 30000 } });

    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const { branchId, items, notes = '' } = req.body;

      // التحقق من الفرع
      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      // التحقق من صلاحية المستخدم
      if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch' });
      }

      // خريطة الأسباب
      const reasonMap = {
        'تالف': 'Damaged',
        'منتج خاطئ': 'Wrong Item',
        'كمية زائدة': 'Excess Quantity',
        'أخرى': 'Other',
      };

      // التحقق من المنتجات والمخزون
      for (const item of items) {
        if (!isValidObjectId(item.product)) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: isRtl ? `معرف المنتج غير صالح: ${item.product}` : `Invalid product ID: ${item.product}` });
        }
        const product = await Product.findById(item.product).session(session);
        if (!product) {
          await session.abortTransaction();
          return res.status(404).json({ success: false, message: isRtl ? `المنتج غير موجود: ${item.product}` : `Product not found: ${item.product}` });
        }
        item.price = item.price != null ? item.price : product.price; // استخدام السعر من المنتج إذا لم يتم إدخاله
        item.reasonEn = item.reasonEn || reasonMap[item.reason];

        const inventory = await Inventory.findOne({ branch: branchId, product: item.product }).session(session);
        if (!inventory) {
          await session.abortTransaction();
          return res.status(404).json({ success: false, message: isRtl ? `لا يوجد مخزون للمنتج ${item.product}` : `No inventory for product ${item.product}` });
        }
        if (inventory.currentStock < item.quantity) {
          await session.abortTransaction();
          return res.status(422).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}` });
        }
      }

      // إنشاء رقم الإرجاع
      const returnCount = await Return.countDocuments({ branch: branchId }).session(session);
      const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(returnCount + 1).toString().padStart(4, '0')}`;

      // إنشاء طلب الإرجاع
      const newReturn = new Return({
        returnNumber,
        branch: branchId,
        items: items.map(item => ({
          product: item.product,
          quantity: item.quantity,
          price: item.price,
          reason: item.reason,
          reasonEn: item.reasonEn,
        })),
        status: 'pending_approval',
        createdBy: req.user.id,
        notes,
      });
      await newReturn.save({ session });

      // تحديث المخزون
      for (const item of items) {
        await updateInventoryStock({
          branch: branchId,
          product: item.product,
          quantity: -item.quantity,
          type: 'return_pending',
          reference: `Return ${returnNumber}`,
          referenceType: 'return',
          referenceId: newReturn._id,
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn})`,
          isPending: true,
        });
      }

      await session.commitTransaction();

      // جلب البيانات مع الـ populate
      const populatedReturn = await Return.findById(newReturn._id)
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn username')
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: {
          ...populatedReturn.branch,
          displayName: isRtl ? (populatedReturn.branch?.name || 'غير معروف') : (populatedReturn.branch?.nameEn || populatedReturn.branch?.name || 'Unknown'),
        },
        items: populatedReturn.items.map(item => ({
          ...item,
          product: {
            ...item.product,
            displayName: isRtl ? (item.product?.name || 'غير معروف') : (item.product?.nameEn || item.product?.name || 'Unknown'),
            displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
            department: item.product?.department ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
            } : null,
          },
          reasonDisplay: isRtl ? item.reason : item.reasonEn,
        })),
        createdByDisplay: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'Unknown'),
      };

      // إرسال الإشعارات
      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id branch').lean();

      const branchName = populatedReturn.branch?.name || 'غير معروف';
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'returnCreated',
          isRtl ? `طلب إرجاع جديد ${formattedReturn.returnNumber} من ${branchName}` : `New return request ${formattedReturn.returnNumber} from ${populatedReturn.branch?.nameEn || branchName}`,
          { returnId: newReturn._id, branchId, eventId: `${newReturn._id}-returnCreated` },
          io,
          true
        );
      }

      // إرسال حدث socket
      io.emit('returnCreated', {
        branchId,
        returnId: newReturn._id,
        status: newReturn.status,
        eventId: new mongoose.Types.ObjectId().toString(),
      });

      res.status(201).json({ success: true, returnRequest: formattedReturn });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في إنشاء طلب الإرجاع:`, {
        message: err.message,
        stack: err.stack,
        requestBody: req.body,
        user: req.user,
      });
      let status = 500;
      let message = err.message || (isRtl ? 'خطأ في السيرفر' : 'Server error');
      if (message.includes('غير موجود') || message.includes('not found')) status = 404;
      else if (message.includes('غير كافية') || message.includes('Insufficient')) status = 422;
      else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
      else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('reason')) status = 400;
      else if (err.name === 'ValidationError') status = 400;

      res.status(status).json({ success: false, message, errorDetails: { name: err.name, code: err.code } });
    } finally {
      session.endSession();
    }
  }
);

// الموافقة أو رفض طلب إرجاع
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id').isMongoId().withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الإرجاع غير صالح' : 'Invalid return ID'),
    body('status').isIn(['approved', 'rejected']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحالة يجب أن تكون إما موافق عليها أو مرفوضة' : 'Status must be either approved or rejected'),
    body('reviewNotes').optional().trim(),
  ],
  async (req, res) => {
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';
    const session = await mongoose.startSession({ defaultTransactionOptions: { maxTimeMS: 30000 } });

    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const { id } = req.params;
      const { status, reviewNotes = '' } = req.body;

      const returnRequest = await Return.findById(id).session(session);
      if (!returnRequest) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
      }
      if (returnRequest.status !== 'pending_approval') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval' });
      }

      let adjustedTotal = 0;
      for (const item of returnRequest.items) {
        const updateType = status === 'approved' && item.reason === 'تالف' ? 'return_approved' : status === 'rejected' ? 'return_rejected' : 'return_approved';
        const isDamaged = status === 'approved' && item.reason === 'تالف';
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: item.product,
          quantity: status === 'rejected' ? item.quantity : -item.quantity,
          type: updateType,
          reference: `${status === 'approved' ? 'Approved' : 'Rejected'} return #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn})`,
          isDamaged,
          isPending: status === 'rejected',
        });
        adjustedTotal += item.quantity * item.price;
      }

      returnRequest.status = status;
      returnRequest.reviewNotes = reviewNotes;
      returnRequest.reviewedBy = req.user.id;
      returnRequest.reviewedAt = new Date();
      returnRequest.statusHistory.push({
        status,
        changedBy: req.user.id,
        notes: reviewNotes,
        changedAt: new Date(),
      });
      await returnRequest.save({ session });

      await session.commitTransaction();

      const populatedReturn = await Return.findById(id)
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn username')
        .populate('reviewedBy', 'name nameEn username')
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: {
          ...populatedReturn.branch,
          displayName: isRtl ? (populatedReturn.branch?.name || 'غير معروف') : (populatedReturn.branch?.nameEn || populatedReturn.branch?.name || 'Unknown'),
        },
        items: populatedReturn.items.map(item => ({
          ...item,
          product: {
            ...item.product,
            displayName: isRtl ? (item.product?.name || 'غير معروف') : (item.product?.nameEn || item.product?.name || 'Unknown'),
            displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
            department: item.product?.department ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
            } : null,
          },
          reasonDisplay: isRtl ? item.reason : item.reasonEn,
        })),
        createdByDisplay: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'Unknown'),
        reviewedByDisplay: isRtl ? (populatedReturn.reviewedBy?.name || 'غير معروف') : (populatedReturn.reviewedBy?.nameEn || populatedReturn.reviewedBy?.name || 'Unknown'),
      };

      // إرسال الإشعارات
      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: returnRequest.branch },
        ],
      }).select('_id branch').lean();

      const branchName = populatedReturn.branch?.name || 'غير معروف';
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'returnStatusUpdated',
          isRtl ? `تم تحديث حالة طلب الإرجاع ${populatedReturn.returnNumber} إلى ${status} بواسطة ${branchName}` : `Return request ${populatedReturn.returnNumber} status updated to ${status} by ${populatedReturn.branch?.nameEn || branchName}`,
          { returnId: id, branchId: returnRequest.branch, status, eventId: `${id}-returnStatusUpdated` },
          io,
          true
        );
      }

      // إرسال حدث socket
      io.emit('returnStatusUpdated', {
        returnId: id,
        branchId: returnRequest.branch,
        status,
        eventId: new mongoose.Types.ObjectId().toString(),
      });

      res.status(200).json({ success: true, returnRequest: { ...formattedReturn, adjustedTotal } });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في الموافقة على طلب الإرجاع:`, {
        message: err.message,
        stack: err.stack,
        requestBody: req.body,
        user: req.user,
      });
      let status = 500;
      let message = err.message || (isRtl ? 'خطأ في السيرفر' : 'Server error');
      if (message.includes('غير موجود') || message.includes('not found')) status = 404;
      else if (message.includes('غير كافية') || message.includes('Insufficient')) status = 422;
      else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
      else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('pending')) status = 400;
      else if (err.name === 'ValidationError') status = 400;

      res.status(status).json({ success: false, message, errorDetails: { name: err.name, code: err.code } });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;