const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

router.get('/', [
  auth,
  authorize('branch', 'production', 'admin'),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], async (req, res) => {
  try {
    const { status, branch, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query['order.branch'] = branch;
    if (req.user.role === 'branch') query['order.branch'] = req.user.branchId;

    console.log(`[${new Date().toISOString()}] Fetching returns with query:`, { query, userId: req.user.id });

    const returns = await Return.find(query)
      .populate('order', 'orderNumber branch totalAmount adjustedTotal')
      .populate({ path: 'order.branch', select: 'name nameEn city cityEn' })
      .populate('items.product', 'name nameEn price unit unitEn')
      .populate('createdBy', 'username name')
      .populate('reviewedBy', 'username name')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const total = await Return.countDocuments(query);

    const formattedReturns = returns.map(returnDoc => ({
      ...returnDoc,
      createdAt: new Date(returnDoc.createdAt).toISOString(),
      reviewedAt: returnDoc.reviewedAt ? new Date(returnDoc.reviewedAt).toISOString() : null,
      items: returnDoc.items.map(item => ({
        ...item,
        displayReason: lang === 'ar' ? item.reason : item.reasonEn,
        productName: item.product?.displayName || item.product?.name || 'N/A',
      })),
      branchName: returnDoc.order?.branch?.displayName || returnDoc.order?.branch?.name || 'N/A',
    }));

    res.status(200).json({ returns: formattedReturns, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching returns:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ 
      success: false, 
      message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  }
});

router.post('/', [
  auth,
  authorize('branch'),
  body('orderId').isMongoId().withMessage({ en: 'Invalid order ID', ar: 'معرف الطلب غير صالح' }),
  body('branchId').isMongoId().withMessage({ en: 'Invalid branch ID', ar: 'معرف الفرع غير صالح' }),
  body('reason').isIn(['تالف', 'منتج خاطئ', 'أخرى']).withMessage({ en: 'Invalid reason', ar: 'سبب غير صالح' }),
  body('items').isArray({ min: 1 }).withMessage({ en: 'Items array required', ar: 'مصفوفة العناصر مطلوبة' }),
  body('items.*.product').isMongoId().withMessage({ en: 'Invalid product ID', ar: 'معرف المنتج غير صالح' }),
  body('items.*.quantity').isInt({ min: 1 }).withMessage({ en: 'Quantity must be positive', ar: 'الكمية يجب أن تكون إيجابية' }),
  body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'أخرى']).withMessage({ en: 'Invalid item reason', ar: 'سبب العنصر غير صالح' }),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: req.query.lang === 'ar' ? 'خطأ في التحقق من البيانات' : 'Validation error', 
        errors: errors.array() 
      });
    }

    const { orderId, branchId, reason, items, notes } = req.body;
    const lang = req.query.lang || 'ar';
    const io = req.app.get('io');

    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false, 
        message: lang === 'ar' ? 'الطلب غير موجود' : 'Order not found' 
      });
    }
    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'يجب أن يكون الطلب مسلمًا لإنشاء إرجاع' : 'Order must be delivered to create a return' 
      });
    }
    if (order.branch.toString() !== branchId || (req.user.role === 'branch' && branchId !== req.user.branchId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ 
        success: false, 
        message: lang === 'ar' ? 'غير مخول لإنشاء إرجاع لهذا الطلب' : 'Unauthorized to create return for this order' 
      });
    }

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    if (new Date(order.createdAt) < threeDaysAgo) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' : 'Cannot create return for order older than 3 days' 
      });
    }

    for (const item of items) {
      const orderItem = order.items.find(i => i.product._id.toString() === item.product && i._id.toString() === item.itemId);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false, 
          message: lang === 'ar' ? `المنتج ${item.product} أو العنصر ${item.itemId} غير موجود في الطلب` : `Product ${item.product} or item ${item.itemId} not found in order` 
        });
      }
      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false, 
          message: lang === 'ar' ? `كمية الإرجاع للعنصر ${item.itemId} تتجاوز الكمية المتاحة` : `Return quantity for item ${item.itemId} exceeds available quantity` 
        });
      }
    }

    for (const item of items) {
      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'out',
              quantity: item.quantity,
              reference: `طلب إرجاع قيد الانتظار`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { new: true, session }
      );
      if (!inventoryUpdate) {
        throw new Error(lang === 'ar' ? `المخزون غير موجود للمنتج ${item.product}` : `Inventory not found for product ${item.product}`);
      }
      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: order.branch,
        action: 'return',
        quantity: -item.quantity,
        reference: `طلب إرجاع قيد الانتظار`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    const returnCount = await Return.countDocuments();
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

    const newReturn = new Return({
      returnNumber,
      order: orderId,
      branch: branchId,
      reason,
      items: items.map(item => ({
        itemId: item.itemId,
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
        reasonEn: item.reason === 'تالف' ? 'defective' : item.reason === 'منتج خاطئ' ? 'wrong_item' : 'other'
      })),
      status: 'pending_approval',
      createdBy: req.user.id,
      createdAt: new Date().toISOString(),
      reviewNotes: notes?.trim(),
    });
    await newReturn.save({ session });

    order.returns.push(newReturn._id);
    await order.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name nameEn')
      .populate('createdBy', 'username name')
      .populate({ path: 'order.branch', select: 'name nameEn city cityEn' })
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .session(session)
      .lean();

    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    const returnEvent = {
      _id: `${newReturn._id}-returnCreated-${Date.now()}`,
      type: 'returnCreated',
      message: {
        ar: `تم إنشاء طلب إرجاع جديد ${newReturn.returnNumber}`,
        en: `New return request ${newReturn.returnNumber} created`
      },
      data: {
        returnId: newReturn._id,
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedReturn.order?.branch?.displayName || 'N/A',
        items: populatedReturn.items,
        eventId: `${newReturn._id}-return_created`
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    await notifyUsers(
      io,
      usersToNotify,
      'returnCreated',
      returnEvent.message,
      returnEvent.data,
      true,
      lang
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnCreated', returnEvent);

    await session.commitTransaction();
    res.status(201).json({
      ...populatedReturn,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ 
      success: false, 
      message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
});

router.put('/:id', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage({ en: 'Invalid return ID', ar: 'معرف الإرجاع غير صالح' }),
  body('status').isIn(['approved', 'rejected']).withMessage({ en: 'Invalid status', ar: 'حالة غير صالحة' }),
  body('reviewNotes').optional().trim(),
  query('lang').optional().isIn(['ar', 'en']).withMessage({ en: 'Invalid language', ar: 'لغة غير صالحة' }),
], async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;
    const lang = req.query.lang || 'ar';
    const io = req.app.get('io');

    const returnRequest = await Return.findById(id)
      .populate('order')
      .populate('items.product')
      .session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false, 
        message: lang === 'ar' ? 'الإرجاع غير موجود' : 'Return not found' 
      });
    }

    const order = await Order.findById(returnRequest.order._id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false, 
        message: lang === 'ar' ? 'الطلب غير موجود' : 'Order not found' 
      });
    }

    let adjustedTotal = order.adjustedTotal;
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          await session.abortTransaction();
          return res.status(400).json({ 
            success: false, 
            message: lang === 'ar' ? `العنصر ${returnItem.itemId} غير موجود في الطلب` : `Item ${returnItem.itemId} not found in order` 
          });
        }
        if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          await session.abortTransaction();
          return res.status(400).json({ 
            success: false, 
            message: lang === 'ar' ? `كمية الإرجاع للعنصر ${returnItem.itemId} تتجاوز الكمية المتاحة` : `Return quantity for item ${returnItem.itemId} exceeds available quantity` 
          });
        }
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        orderItem.returnReasonEn = returnItem.reasonEn;
        adjustedTotal -= returnItem.quantity * orderItem.price;
      }
      order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;
      order.markModified('items');
      await order.save({ session });
    } else if (status === 'rejected') {
      for (const returnItem of returnRequest.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: returnItem.quantity,
                reference: `رفض إرجاع #${returnRequest._id}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );
        const historyEntry = new InventoryHistory({
          product: returnItem.product,
          branch: returnRequest.order?.branch,
          action: 'return_rejected',
          quantity: returnItem.quantity,
          reference: `رفض إرجاع #${returnRequest._id}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });
      }
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date().toISOString();
    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name nameEn')
      .populate('createdBy', 'username name')
      .populate('reviewedBy', 'username name')
      .populate({ path: 'order.branch', select: 'name nameEn city cityEn' })
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.order?.branch },
      ],
    }).select('_id role').lean();

    const returnEvent = {
      _id: `${id}-returnStatusUpdated-${Date.now()}`,
      type: 'returnStatusUpdated',
      message: {
        ar: `تم تحديث حالة الإرجاع ${returnRequest.returnNumber} إلى ${status === 'approved' ? 'معتمد' : 'مرفوض'}`,
        en: `Return ${returnRequest.returnNumber} status updated to ${status}`
      },
      data: {
        returnId: id,
        orderId: returnRequest.order?._id,
        orderNumber: returnRequest.order?.orderNumber,
        branchId: returnRequest.order?.branch,
        branchName: populatedReturn.order?.branch?.displayName || 'N/A',
        status,
        items: populatedReturn.items,
        eventId: `${id}-return_status_updated`
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    await notifyUsers(
      io,
      usersToNotify,
      'returnStatusUpdated',
      returnEvent.message,
      returnEvent.data,
      true,
      lang
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.order?.branch}`], 'returnStatusUpdated', returnEvent);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedReturn,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: order.adjustedTotal,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ 
      success: false, 
      message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
});

module.exports = router;