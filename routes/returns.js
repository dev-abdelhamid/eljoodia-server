const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, query, param, validationResult } = require('express-validator');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const mongoose = require('mongoose');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper function to get display names based on language
const getDisplayName = (name, nameEn, isRtl) => {
  return isRtl ? (name || 'غير معروف') : (nameEn || name || 'Unknown');
};

// Helper function to emit Socket.IO events
const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = new Set(rooms);
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
    eventData: eventDataWithSound,
  });
};

// Helper function to notify users
const notifyUsers = async (io, users, type, messageKey, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, data, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }
};

// Get all returns
router.get(
  '/',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1 }).withMessage('Limit must be a positive integer'),
    query('status').optional().isIn(['pending', 'approved', 'rejected']).withMessage('Invalid status'),
    query('branch').optional().custom(isValidObjectId).withMessage('Invalid branch ID'),
    query('search').optional().isLength({ max: 100 }).withMessage('Search query too long'),
    query('sortBy').optional().isIn(['createdAt', 'returnNumber', 'status']).withMessage('Invalid sortBy field'),
    query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('Invalid sortOrder'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: req.query.isRtl === 'true' ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const isRtl = req.query.isRtl === 'true';
      const { status, branch, page = 1, limit = 10, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

      // Build query
      const query = {};
      if (status) query.status = status;
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;
      if (search) {
        query.$or = [
          { returnNumber: { $regex: search, $options: 'i' } },
          { reason: { $regex: search, $options: 'i' } },
          { reasonEn: { $regex: search, $options: 'i' } },
        ];
      }

      // Build sort
      const sort = {};
      sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

      // Fetch returns
      const returns = await Return.find(query)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch notes notesEn')
        .populate('branch', 'name nameEn')
        .populate('items.product', 'name nameEn price unit unitEn department')
        .populate({ path: 'items.product.department', select: 'name nameEn' })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .setOptions({ context: { isRtl } })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .sort(sort)
        .lean();

      const total = await Return.countDocuments(query);

      // Format response for frontend
      const formattedReturns = returns.map(ret => ({
        id: ret._id.toString(),
        returnNumber: ret.returnNumber,
        order: {
          id: ret.order?._id?.toString() || 'unknown',
          orderNumber: ret.order?.orderNumber || (isRtl ? 'طلب غير معروف' : 'Unknown order'),
          totalAmount: Number(ret.order?.totalAmount) || 0,
          adjustedTotal: Number(ret.order?.adjustedTotal) || 0,
          branch: ret.order?.branch?._id?.toString() || 'unknown',
          branchName: getDisplayName(ret.order?.branch?.name, ret.order?.branch?.nameEn, isRtl),
          displayNotes: ret.order?.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        },
        items: ret.items.map(item => ({
          product: {
            _id: item.product?._id?.toString() || 'unknown',
            name: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            price: Number(item.product?.price) || 0,
            unit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
            department: {
              _id: item.product?.department?._id?.toString() || 'unknown',
              name: getDisplayName(item.product?.department?.name, item.product?.department?.nameEn, isRtl),
            },
          },
          quantity: Number(item.quantity) || 0,
          reason: item.reason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          reasonEn: item.reasonEn || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          displayReason: item.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        })),
        status: ret.status || 'pending',
        createdAt: ret.createdAt || new Date().toISOString(),
        notes: ret.notes || '',
        reviewNotes: ret.reviewNotes || '',
        branch: {
          _id: ret.branch?._id?.toString() || 'unknown',
          name: getDisplayName(ret.branch?.name, ret.branch?.nameEn, isRtl),
        },
        createdBy: {
          _id: ret.createdBy?._id?.toString() || 'unknown',
          username: ret.createdBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
          name: getDisplayName(ret.createdBy?.name, ret.createdBy?.nameEn, isRtl),
        },
        reviewedBy: ret.reviewedBy
          ? {
              _id: ret.reviewedBy._id.toString(),
              username: ret.reviewedBy.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
              name: getDisplayName(ret.reviewedBy.name, ret.reviewedBy.nameEn, isRtl),
            }
          : undefined,
        displayReason: ret.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        displayNotes: ret.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        statusHistory: ret.statusHistory.map(history => ({
          status: history.status,
          changedBy: {
            _id: history.changedBy?._id?.toString() || 'unknown',
            username: history.changedBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
            name: getDisplayName(history.changedBy?.name, history.changedBy?.nameEn, isRtl),
          },
          notes: history.notes || '',
          displayNotes: history.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
          changedAt: history.changedAt || new Date().toISOString(),
        })),
      }));

      res.status(200).json({
        success: true,
        returns: formattedReturns,
        total,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns:`, err);
      res.status(500).json({
        success: false,
        message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
    }
  }
);

// Get a single return by ID
router.get(
  '/:id',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    param('id').custom(isValidObjectId).withMessage('Invalid return ID'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: req.query.isRtl === 'true' ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const isRtl = req.query.isRtl === 'true';
      const { id } = req.params;

      const returnDoc = await Return.findById(id)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch notes notesEn')
        .populate('branch', 'name nameEn')
        .populate('items.product', 'name nameEn price unit unitEn department')
        .populate({ path: 'items.product.department', select: 'name nameEn' })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .setOptions({ context: { isRtl } })
        .lean();

      if (!returnDoc) {
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الإرجاع غير موجود' : 'Return not found',
        });
      }

      const formattedReturn = {
        id: returnDoc._id.toString(),
        returnNumber: returnDoc.returnNumber,
        order: {
          id: returnDoc.order?._id?.toString() || 'unknown',
          orderNumber: returnDoc.order?.orderNumber || (isRtl ? 'طلب غير معروف' : 'Unknown order'),
          totalAmount: Number(returnDoc.order?.totalAmount) || 0,
          adjustedTotal: Number(returnDoc.order?.adjustedTotal) || 0,
          branch: returnDoc.order?.branch?._id?.toString() || 'unknown',
          branchName: getDisplayName(returnDoc.order?.branch?.name, returnDoc.order?.branch?.nameEn, isRtl),
          displayNotes: returnDoc.order?.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        },
        items: returnDoc.items.map(item => ({
          product: {
            _id: item.product?._id?.toString() || 'unknown',
            name: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            price: Number(item.product?.price) || 0,
            unit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
            department: {
              _id: item.product?.department?._id?.toString() || 'unknown',
              name: getDisplayName(item.product?.department?.name, item.product?.department?.nameEn, isRtl),
            },
          },
          quantity: Number(item.quantity) || 0,
          reason: item.reason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          reasonEn: item.reasonEn || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          displayReason: item.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        })),
        status: returnDoc.status || 'pending',
        createdAt: returnDoc.createdAt || new Date().toISOString(),
        notes: returnDoc.notes || '',
        reviewNotes: returnDoc.reviewNotes || '',
        branch: {
          _id: returnDoc.branch?._id?.toString() || 'unknown',
          name: getDisplayName(returnDoc.branch?.name, returnDoc.branch?.nameEn, isRtl),
        },
        createdBy: {
          _id: returnDoc.createdBy?._id?.toString() || 'unknown',
          username: returnDoc.createdBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
          name: getDisplayName(returnDoc.createdBy?.name, returnDoc.createdBy?.nameEn, isRtl),
        },
        reviewedBy: returnDoc.reviewedBy
          ? {
              _id: returnDoc.reviewedBy._id.toString(),
              username: returnDoc.reviewedBy.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
              name: getDisplayName(returnDoc.reviewedBy.name, returnDoc.reviewedBy.nameEn, isRtl),
            }
          : undefined,
        displayReason: returnDoc.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        displayNotes: returnDoc.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        statusHistory: returnDoc.statusHistory.map(history => ({
          status: history.status,
          changedBy: {
            _id: history.changedBy?._id?.toString() || 'unknown',
            username: history.changedBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
            name: getDisplayName(history.changedBy?.name, history.changedBy?.nameEn, isRtl),
          },
          notes: history.notes || '',
          displayNotes: history.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
          changedAt: history.changedAt || new Date().toISOString(),
        })),
      };

      res.status(200).json({
        success: true,
        return: formattedReturn,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching return:`, err);
      res.status(500).json({
        success: false,
        message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
    }
  }
);

// Create a return
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').custom(isValidObjectId).withMessage('Invalid order ID'),
    body('branchId').custom(isValidObjectId).withMessage('Invalid branch ID'),
    body('reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid reason'),
    body('items').isArray({ min: 1 }).withMessage('Items array must contain at least one item'),
    body('items.*.product').custom(isValidObjectId).withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage('Invalid item reason'),
    body('notes').optional().trim().isLength({ max: 500 }).withMessage('Notes too long'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: req.query.isRtl === 'true' ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const isRtl = req.query.isRtl === 'true';
      const { orderId, branchId, reason, items, notes } = req.body;

      // Validate order
      const order = await Order.findById(orderId).populate('items.product').session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        });
      }

      // Check order status
      if (order.status !== 'delivered') {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'يجب أن يكون الطلب في حالة "تم التسليم"' : 'Order must be in "delivered" status',
        });
      }

      // Check branch authorization
      if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
        await session.abortTransaction();
        return res.status(403).json({
          success: false,
          message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch',
        });
      }

      // Check order age (3 days)
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      if (new Date(order.createdAt) < threeDaysAgo) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' : 'Cannot create return for order older than 3 days',
        });
      }

      // Validate items
      for (const item of items) {
        const orderItem = order.items.find(i => i.product._id.toString() === item.product.toString());
        if (!orderItem) {
          await session.abortTransaction();
          return res.status(400).json({
            success: false,
            message: isRtl ? `المنتج ${item.product} غير موجود في الطلب` : `Product ${item.product} not found in order`,
          });
        }
        if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          await session.abortTransaction();
          return res.status(400).json({
            success: false,
            message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للمنتج ${item.product}` : `Return quantity exceeds available quantity for product ${item.product}`,
          });
        }
      }

      // Update inventory (pending return)
      for (const item of items) {
        const inventoryUpdate = await Inventory.findOneAndUpdate(
          { branch: order.branch, product: item.product },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: isRtl ? 'طلب إرجاع قيد الانتظار' : 'Pending return request',
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );
        if (!inventoryUpdate) {
          throw new Error(isRtl ? `المخزون غير موجود للمنتج ${item.product}` : `Inventory not found for product ${item.product}`);
        }
        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: order.branch,
          action: 'return_pending',
          quantity: -item.quantity,
          reference: isRtl ? 'طلب إرجاع قيد الانتظار' : 'Pending return request',
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });
      }

      // Generate return number
      const returnCount = await Return.countDocuments().session(session);
      const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

      // Create return
      const newReturn = new Return({
        returnNumber,
        order: orderId,
        branch: branchId,
        reason,
        items: items.map(item => ({
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
        })),
        status: 'pending',
        createdBy: req.user.id,
        notes: notes?.trim(),
      });

      await newReturn.save({ session });
      order.returns.push(newReturn._id);
      await order.save({ session });

      // Populate return data
      const populatedReturn = await Return.findById(newReturn._id)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch notes notesEn')
        .populate('branch', 'name nameEn')
        .populate('items.product', 'name nameEn price unit unitEn department')
        .populate({ path: 'items.product.department', select: 'name nameEn' })
        .populate('createdBy', 'username name nameEn')
        .setOptions({ context: { isRtl } })
        .session(session)
        .lean();

      // Send notifications
      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id role').lean();

      await notifyUsers(
        io,
        usersToNotify,
        'return_created',
        isRtl ? 'notifications.return_created_ar' : 'notifications.return_created_en',
        {
          returnId: newReturn._id,
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${newReturn._id}-return_created`,
        }
      );

      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnCreated', {
        _id: newReturn._id.toString(),
        returnNumber,
        order: {
          _id: order._id.toString(),
          orderNumber: order.orderNumber,
          totalAmount: Number(order.totalAmount),
          adjustedTotal: Number(order.adjustedTotal),
          branch: order.branch.toString(),
          branchName: getDisplayName(populatedReturn.branch?.name, populatedReturn.branch?.nameEn, isRtl),
          displayNotes: populatedReturn.order?.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        },
        items: populatedReturn.items.map(item => ({
          product: {
            _id: item.product?._id?.toString() || 'unknown',
            name: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            price: Number(item.product?.price) || 0,
            unit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
            department: {
              _id: item.product?.department?._id?.toString() || 'unknown',
              name: getDisplayName(item.product?.department?.name, item.product?.department?.nameEn, isRtl),
            },
          },
          quantity: Number(item.quantity) || 0,
          reason: item.reason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          reasonEn: item.reasonEn || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          displayReason: item.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        })),
        status: 'pending',
        createdAt: new Date(populatedReturn.createdAt).toISOString(),
        notes: populatedReturn.notes || '',
        branch: {
          _id: populatedReturn.branch?._id?.toString() || 'unknown',
          name: getDisplayName(populatedReturn.branch?.name, populatedReturn.branch?.nameEn, isRtl),
        },
        createdBy: {
          _id: populatedReturn.createdBy?._id?.toString() || 'unknown',
          username: populatedReturn.createdBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
          name: getDisplayName(populatedReturn.createdBy?.name, populatedReturn.createdBy?.nameEn, isRtl),
        },
        displayReason: populatedReturn.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        displayNotes: populatedReturn.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
      });

      await session.commitTransaction();

      // Format response for frontend
      const formattedReturn = {
        id: populatedReturn._id.toString(),
        returnNumber: populatedReturn.returnNumber,
        order: {
          id: populatedReturn.order?._id?.toString() || 'unknown',
          orderNumber: populatedReturn.order?.orderNumber || (isRtl ? 'طلب غير معروف' : 'Unknown order'),
          totalAmount: Number(populatedReturn.order?.totalAmount) || 0,
          adjustedTotal: Number(populatedReturn.order?.adjustedTotal) || 0,
          branch: populatedReturn.order?.branch?._id?.toString() || 'unknown',
          branchName: getDisplayName(populatedReturn.order?.branch?.name, populatedReturn.order?.branch?.nameEn, isRtl),
          displayNotes: populatedReturn.order?.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        },
        items: populatedReturn.items.map(item => ({
          product: {
            _id: item.product?._id?.toString() || 'unknown',
            name: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            price: Number(item.product?.price) || 0,
            unit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
            department: {
              _id: item.product?.department?._id?.toString() || 'unknown',
              name: getDisplayName(item.product?.department?.name, item.product?.department?.nameEn, isRtl),
            },
          },
          quantity: Number(item.quantity) || 0,
          reason: item.reason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          reasonEn: item.reasonEn || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          displayReason: item.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        })),
        status: populatedReturn.status || 'pending',
        createdAt: populatedReturn.createdAt || new Date().toISOString(),
        notes: populatedReturn.notes || '',
        reviewNotes: populatedReturn.reviewNotes || '',
        branch: {
          _id: populatedReturn.branch?._id?.toString() || 'unknown',
          name: getDisplayName(populatedReturn.branch?.name, populatedReturn.branch?.nameEn, isRtl),
        },
        createdBy: {
          _id: populatedReturn.createdBy?._id?.toString() || 'unknown',
          username: populatedReturn.createdBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
          name: getDisplayName(populatedReturn.createdBy?.name, populatedReturn.createdBy?.nameEn, isRtl),
        },
        displayReason: populatedReturn.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        displayNotes: populatedReturn.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        statusHistory: populatedReturn.statusHistory.map(history => ({
          status: history.status,
          changedBy: {
            _id: history.changedBy?._id?.toString() || 'unknown',
            username: history.changedBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
            name: getDisplayName(history.changedBy?.name, history.changedBy?.nameEn, isRtl),
          },
          notes: history.notes || '',
          displayNotes: history.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
          changedAt: history.changedAt || new Date().toISOString(),
        })),
      };

      res.status(201).json({
        success: true,
        return: formattedReturn,
      });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error creating return:`, err);
      res.status(500).json({
        success: false,
        message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
    } finally {
      session.endSession();
    }
  }
);

// Approve or reject a return
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id').custom(isValidObjectId).withMessage('Invalid return ID'),
    body('status').isIn(['approved', 'rejected']).withMessage('Status must be approved or rejected'),
    body('reviewNotes').optional().trim().isLength({ max: 500 }).withMessage('Review notes too long'),
    query('isRtl').optional().isBoolean().withMessage('isRtl must be a boolean'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: req.query.isRtl === 'true' ? 'خطأ في التحقق من البيانات' : 'Validation error',
          errors: errors.array(),
        });
      }

      const isRtl = req.query.isRtl === 'true';
      const { id } = req.params;
      const { status, reviewNotes } = req.body;

      // Fetch return
      const returnDoc = await Return.findById(id)
        .populate('order')
        .populate('items.product')
        .setOptions({ context: { isRtl } })
        .session(session);

      if (!returnDoc) {
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الإرجاع غير موجود' : 'Return not found',
        });
      }

      // Fetch order
      const order = await Order.findById(returnDoc.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        });
      }

      // Update order total and items for approved returns
      let adjustedTotal = order.adjustedTotal || order.totalAmount;
      if (status === 'approved') {
        for (const returnItem of returnDoc.items) {
          const orderItem = order.items.find(i => i.product.toString() === returnItem.product.toString());
          if (!orderItem) {
            await session.abortTransaction();
            return res.status(400).json({
              success: false,
              message: isRtl ? `العنصر ${returnItem.product} غير موجود في الطلب` : `Item ${returnItem.product} not found in order`,
            });
          }
          if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
            await session.abortTransaction();
            return res.status(400).json({
              success: false,
              message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${returnItem.product}` : `Return quantity exceeds available quantity for item ${returnItem.product}`,
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

        // Update inventory for approved return
        for (const returnItem of returnDoc.items) {
          await Inventory.findOneAndUpdate(
            { branch: returnDoc.branch, product: returnItem.product },
            {
              $inc: { currentStock: returnItem.quantity },
              $push: {
                movements: {
                  type: 'in',
                  quantity: returnItem.quantity,
                  reference: isRtl ? `إرجاع مقبول #${returnDoc.returnNumber}` : `Approved return #${returnDoc.returnNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, session }
          );
          const historyEntry = new InventoryHistory({
            product: returnItem.product,
            branch: returnDoc.branch,
            action: 'return_approved',
            quantity: returnItem.quantity,
            reference: isRtl ? `إرجاع مقبول #${returnDoc.returnNumber}` : `Approved return #${returnDoc.returnNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });
        }
      } else if (status === 'rejected') {
        // Revert inventory for rejected return
        for (const returnItem of returnDoc.items) {
          await Inventory.findOneAndUpdate(
            { branch: returnDoc.branch, product: returnItem.product },
            {
              $inc: { currentStock: returnItem.quantity },
              $push: {
                movements: {
                  type: 'in',
                  quantity: returnItem.quantity,
                  reference: isRtl ? `رفض إرجاع #${returnDoc.returnNumber}` : `Rejected return #${returnDoc.returnNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, session }
          );
          const historyEntry = new InventoryHistory({
            product: returnItem.product,
            branch: returnDoc.branch,
            action: 'return_rejected',
            quantity: returnItem.quantity,
            reference: isRtl ? `رفض إرجاع #${returnDoc.returnNumber}` : `Rejected return #${returnDoc.returnNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });
        }
      }

      // Update return status
      returnDoc.status = status;
      returnDoc.reviewNotes = reviewNotes?.trim();
      returnDoc.reviewedBy = req.user.id;
      returnDoc.reviewedAt = new Date();
      returnDoc.statusHistory.push({
        status,
        changedBy: req.user.id,
        notes: reviewNotes,
        changedAt: new Date(),
      });
      await returnDoc.save({ session });

      // Populate return data
      const populatedReturn = await Return.findById(id)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch notes notesEn')
        .populate('branch', 'name nameEn')
        .populate('items.product', 'name nameEn price unit unitEn department')
        .populate({ path: 'items.product.department', select: 'name nameEn' })
        .populate('createdBy', 'username name nameEn')
        .populate('reviewedBy', 'username name nameEn')
        .setOptions({ context: { isRtl } })
        .session(session)
        .lean();

      // Send notifications
      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: returnDoc.branch },
        ],
      }).select('_id role').lean();

      await notifyUsers(
        io,
        usersToNotify,
        'return_status_updated',
        isRtl ? 'notifications.return_status_updated_ar' : 'notifications.return_status_updated_en',
        {
          returnId: id,
          orderId: returnDoc.order._id,
          orderNumber: returnDoc.order.orderNumber,
          branchId: returnDoc.branch,
          eventId: `${id}-return_status_updated`,
        }
      );

      await emitSocketEvent(io, ['admin', 'production', `branch-${returnDoc.branch}`], 'returnStatusUpdated', {
        _id: id.toString(),
        returnNumber: populatedReturn.returnNumber,
        order: {
          _id: populatedReturn.order?._id?.toString() || 'unknown',
          orderNumber: populatedReturn.order?.orderNumber || (isRtl ? 'طلب غير معروف' : 'Unknown order'),
          totalAmount: Number(populatedReturn.order?.totalAmount) || 0,
          adjustedTotal: Number(populatedReturn.order?.adjustedTotal) || 0,
          branch: populatedReturn.order?.branch?._id?.toString() || 'unknown',
          branchName: getDisplayName(populatedReturn.order?.branch?.name, populatedReturn.order?.branch?.nameEn, isRtl),
          displayNotes: populatedReturn.order?.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        },
        items: populatedReturn.items.map(item => ({
          product: {
            _id: item.product?._id?.toString() || 'unknown',
            name: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            price: Number(item.product?.price) || 0,
            unit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
            department: {
              _id: item.product?.department?._id?.toString() || 'unknown',
              name: getDisplayName(item.product?.department?.name, item.product?.department?.nameEn, isRtl),
            },
          },
          quantity: Number(item.quantity) || 0,
          reason: item.reason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          reasonEn: item.reasonEn || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          displayReason: item.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        })),
        status,
        createdAt: populatedReturn.createdAt || new Date().toISOString(),
        notes: populatedReturn.notes || '',
        reviewNotes: populatedReturn.reviewNotes || '',
        branch: {
          _id: populatedReturn.branch?._id?.toString() || 'unknown',
          name: getDisplayName(populatedReturn.branch?.name, populatedReturn.branch?.nameEn, isRtl),
        },
        createdBy: {
          _id: populatedReturn.createdBy?._id?.toString() || 'unknown',
          username: populatedReturn.createdBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
          name: getDisplayName(populatedReturn.createdBy?.name, populatedReturn.createdBy?.nameEn, isRtl),
        },
        reviewedBy: populatedReturn.reviewedBy
          ? {
              _id: populatedReturn.reviewedBy._id.toString(),
              username: populatedReturn.reviewedBy.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
              name: getDisplayName(populatedReturn.reviewedBy.name, populatedReturn.reviewedBy.nameEn, isRtl),
            }
          : undefined,
        displayReason: populatedReturn.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        displayNotes: populatedReturn.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        statusHistory: populatedReturn.statusHistory.map(history => ({
          status: history.status,
          changedBy: {
            _id: history.changedBy?._id?.toString() || 'unknown',
            username: history.changedBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
            name: getDisplayName(history.changedBy?.name, history.changedBy?.nameEn, isRtl),
          },
          notes: history.notes || '',
          displayNotes: history.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
          changedAt: history.changedAt || new Date().toISOString(),
        })),
      });

      await session.commitTransaction();

      // Format response for frontend
      const formattedReturn = {
        id: populatedReturn._id.toString(),
        returnNumber: populatedReturn.returnNumber,
        order: {
          id: populatedReturn.order?._id?.toString() || 'unknown',
          orderNumber: populatedReturn.order?.orderNumber || (isRtl ? 'طلب غير معروف' : 'Unknown order'),
          totalAmount: Number(populatedReturn.order?.totalAmount) || 0,
          adjustedTotal: Number(populatedReturn.order?.adjustedTotal) || 0,
          branch: populatedReturn.order?.branch?._id?.toString() || 'unknown',
          branchName: getDisplayName(populatedReturn.order?.branch?.name, populatedReturn.order?.branch?.nameEn, isRtl),
          displayNotes: populatedReturn.order?.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        },
        items: populatedReturn.items.map(item => ({
          product: {
            _id: item.product?._id?.toString() || 'unknown',
            name: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            price: Number(item.product?.price) || 0,
            unit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
            department: {
              _id: item.product?.department?._id?.toString() || 'unknown',
              name: getDisplayName(item.product?.department?.name, item.product?.department?.nameEn, isRtl),
            },
          },
          quantity: Number(item.quantity) || 0,
          reason: item.reason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          reasonEn: item.reasonEn || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
          displayReason: item.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        })),
        status: populatedReturn.status || 'pending',
        createdAt: populatedReturn.createdAt || new Date().toISOString(),
        notes: populatedReturn.notes || '',
        reviewNotes: populatedReturn.reviewNotes || '',
        branch: {
          _id: populatedReturn.branch?._id?.toString() || 'unknown',
          name: getDisplayName(populatedReturn.branch?.name, populatedReturn.branch?.nameEn, isRtl),
        },
        createdBy: {
          _id: populatedReturn.createdBy?._id?.toString() || 'unknown',
          username: populatedReturn.createdBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
          name: getDisplayName(populatedReturn.createdBy?.name, populatedReturn.createdBy?.nameEn, isRtl),
        },
        reviewedBy: populatedReturn.reviewedBy
          ? {
              _id: populatedReturn.reviewedBy._id.toString(),
              username: populatedReturn.reviewedBy.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
              name: getDisplayName(populatedReturn.reviewedBy.name, populatedReturn.reviewedBy.nameEn, isRtl),
            }
          : undefined,
        displayReason: populatedReturn.displayReason || (isRtl ? 'سبب غير معروف' : 'Unknown reason'),
        displayNotes: populatedReturn.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
        statusHistory: populatedReturn.statusHistory.map(history => ({
          status: history.status,
          changedBy: {
            _id: history.changedBy?._id?.toString() || 'unknown',
            username: history.changedBy?.username || (isRtl ? 'مستخدم غير معروف' : 'Unknown user'),
            name: getDisplayName(history.changedBy?.name, history.changedBy?.nameEn, isRtl),
          },
          notes: history.notes || '',
          displayNotes: history.displayNotes || (isRtl ? 'لا توجد ملاحظات' : 'No notes'),
          changedAt: history.changedAt || new Date().toISOString(),
        })),
      };

      res.status(200).json({
        success: true,
        return: formattedReturn,
        adjustedTotal: order.adjustedTotal,
      });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error approving return:`, err);
      res.status(500).json({
        success: false,
        message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error',
        error: err.message,
      });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;