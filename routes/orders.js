const express = require('express');
const { body, param, query } = require('express-validator');
const { 
  createOrder, 
  getOrders, 
  updateOrderStatus, 
  assignChefs,
  confirmDelivery,
  approveReturn,
  getOrderById,
  checkOrderExists,
  createReturn
} = require('../controllers/orderController');
const { 
  createTask, 
  getTasks, 
  getChefTasks, 
  updateTaskStatus 
} = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const mongoose = require('mongoose');

const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
  headers: true,
});

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع طلبات الإرجاع
router.get(
  '/',
  [
    auth,
    authorize('branch', 'production', 'admin'),
    query('branch').optional().custom((value) => !value || isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('page').optional().isInt({ min: 1 }).withMessage('رقم الصفحة يجب أن يكون عددًا صحيحًا إيجابيًا'),
    query('limit').optional().isInt({ min: 1 }).withMessage('الحد يجب أن يكون عددًا صحيحًا إيجابيًا'),
  ],
  async (req, res) => {
    try {
      console.log(`[${new Date().toISOString()}] User accessing /api/returns:`, { userId: req.user.id, role: req.user.role });
      const { status, branch, page = 1, limit = 10 } = req.query;
      const query = {};
      if (status) query.status = status;
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch')
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .populate('createdBy', 'username')
        .populate('reviewedBy', 'username')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const formattedReturns = returns.map(ret => ({
        ...ret,
        createdAt: new Date(ret.createdAt).toISOString(),
        reviewedAt: ret.reviewedAt ? new Date(ret.reviewedAt).toISOString() : null,
        statusHistory: ret.statusHistory?.map(history => ({
          ...history,
          changedAt: new Date(history.changedAt).toISOString(),
        })),
      }));

      const total = await Return.countDocuments(query);

      console.log(`[${new Date().toISOString()}] Fetched ${returns.length} returns, total: ${total}`);
      res.status(200).json({ returns: formattedReturns, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching returns:`, { error: err.message, userId: req.user.id });
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
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.itemId').isMongoId().withMessage('معرف العنصر غير صالح'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.reason').isIn(['defective', 'wrong_item', 'other']).withMessage('سبب الإرجاع غير صالح'),
    body('notes').optional().trim(),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Validation error in createReturn:`, { errors: errors.array(), userId: req.user.id });
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { orderId, branchId, items, notes } = req.body;

      const order = await Order.findById(orderId).populate('items.product').session(session);
      if (!order) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }

      if (order.status !== 'delivered') {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid order status for return: ${order.status}, User: ${req.user.id}`);
        return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم" لإنشاء طلب إرجاع' });
      }

      if (order.branch.toString() !== branchId || (req.user.role === 'branch' && branchId !== req.user.branchId.toString())) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch, userId: req.user.id });
        return res.status(403).json({ success: false, message: 'غير مخول لإنشاء إرجاع لهذا الطلب' });
      }

      // التحقق من أن الطلب لا يزيد عمره عن 3 أيام
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      if (new Date(order.createdAt) < threeDaysAgo) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order too old for return: ${orderId}, Created: ${order.createdAt}, User: ${req.user.id}`);
        return res.status(400).json({ success: false, message: 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' });
      }

      // التحقق من العناصر
      for (const item of items) {
        const orderItem = order.items.find(i => i._id.toString() === item.itemId && i.product._id.toString() === item.product);
        if (!orderItem) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid return item:`, { itemId: item.itemId, product: item.product, userId: req.user.id });
          return res.status(400).json({ success: false, message: `العنصر ${item.itemId} أو المنتج ${item.product} غير موجود في الطلب` });
        }
        const availableQuantity = orderItem.quantity - (orderItem.returnedQuantity || 0);
        if (item.quantity > availableQuantity) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { itemId: item.itemId, requested: item.quantity, available: availableQuantity, userId: req.user.id });
          return res.status(400).json({ success: false, message: `كمية الإرجاع للعنصر ${item.itemId} تتجاوز الكمية المتاحة (${availableQuantity})` });
        }
      }

      // إنشاء رقم الإرجاع باستخدام generateOrderNumber
      const generateOrderNumber = async (date = new Date()) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const prefix = `${year}${month}${day}`;
        const lastOrder = await Order.findOne({ orderNumber: { $regex: `^${prefix}-` } })
          .sort({ orderNumber: -1 })
          .select('orderNumber')
          .lean()
          .session(session);
        const lastReturn = await Return.findOne({ orderNumber: { $regex: `^${prefix}-` } })
          .sort({ orderNumber: -1 })
          .select('orderNumber')
          .lean()
          .session(session);
        let sequence = 1;
        const lastNumber = [lastOrder, lastReturn]
          .filter(Boolean)
          .map(doc => parseInt(doc.orderNumber.split('-')[1] || '0', 10))
          .sort((a, b) => b - a)[0] || 0;
        sequence = lastNumber + 1;
        return `${prefix}-${String(sequence).padStart(4, '0')}`;
      };
      const returnNumber = await generateOrderNumber();

      // إنشاء طلب الإرجاع
      const newReturn = new Return({
        returnNumber,
        order: orderId,
        branch: branchId,
        items: items.map(item => ({
          itemId: item.itemId,
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
          status: 'pending_approval',
        })),
        status: 'pending_approval',
        createdBy: req.user.id,
        createdAt: new Date().toISOString(),
        notes: notes?.trim(),
      });

      await newReturn.save({ session });

      // تحديث الطلب بإضافة الإرجاع
      order.returns = order.returns || [];
      order.returns.push(newReturn._id);
      await order.save({ session });

      // ملء البيانات
      const populatedReturn = await Return.findById(newReturn._id)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch')
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .populate('createdBy', 'username')
        .session(session)
        .lean();

      // إرسال حدث Socket.IO
      const io = req.app.get('io');
      const returnData = {
        returnId: newReturn._id,
        orderId,
        orderNumber: returnNumber,
        status: 'pending_approval',
        branchId,
        branchName: populatedReturn.branch?.name || 'Unknown',
        items: populatedReturn.items,
        createdAt: new Date(populatedReturn.createdAt).toISOString(),
        notes: notes?.trim(),
        eventId: `${newReturn._id}-return_created`,
      };
      const usersToNotify = await User.find({ 
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: branchId }
        ]
      }).select('_id role branch').lean();
      for (const user of usersToNotify) {
        await require('../utils/notifications').createNotification(
          user._id,
          'return_created',
          `تم إنشاء طلب إرجاع جديد ${returnNumber} للطلب ${order.orderNumber}`,
          { returnId: newReturn._id, orderId, orderNumber: returnNumber, branchId, eventId: returnData.eventId },
          io
        );
      }
      io.of('/api').to(['admin', 'production', `branch-${branchId}`]).emit('returnCreated', {
        ...returnData,
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      });

      await session.commitTransaction();
      console.log(`[${new Date().toISOString()}] Return created successfully: ${returnNumber}, User: ${req.user.id}`);
      res.status(201).json({
        ...populatedReturn,
        createdAt: new Date(populatedReturn.createdAt).toISOString(),
      });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });
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
    param('id').isMongoId().withMessage('معرف الإرجاع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.status').isIn(['approved', 'rejected']).withMessage('حالة العنصر يجب أن تكون "approved" أو "rejected"'),
    body('items.*.reviewNotes').optional().trim(),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Validation error in approveReturn:`, { errors: errors.array(), userId: req.user.id });
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { id } = req.params;
      const { items } = req.body;

      const returnDoc = await Return.findById(id).populate('order items.product').session(session);
      if (!returnDoc) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Return not found: ${id}, User: ${req.user.id}`);
        return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
      }

      const order = await Order.findById(returnDoc.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order not found: ${returnDoc.order._id}, User: ${req.user.id}`);
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }

      // التحقق من العناصر
      let returnTotal = 0;
      for (const inputItem of items) {
        const returnItem = returnDoc.items.find(i => i.product.toString() === inputItem.productId);
        if (!returnItem || returnItem.itemId.toString() !== inputItem.itemId) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid return item:`, { productId: inputItem.productId, itemId: inputItem.itemId, userId: req.user.id });
          return res.status(400).json({ success: false, message: `العنصر ${inputItem.itemId} غير موجود في طلب الإرجاع` });
        }
        const orderItem = order.items.find(i => i._id.toString() === returnItem.itemId);
        if (!orderItem) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Order item not found: ${returnItem.itemId}, User: ${req.user.id}`);
          return res.status(400).json({ success: false, message: `العنصر ${returnItem.itemId} غير موجود في الطلب` });
        }
        const availableQuantity = orderItem.quantity - (orderItem.returnedQuantity || 0);
        if (returnItem.quantity > availableQuantity) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { itemId: returnItem.itemId, requested: returnItem.quantity, available: availableQuantity, userId: req.user.id });
          return res.status(400).json({ success: false, message: `كمية الإرجاع للعنصر ${returnItem.itemId} تتجاوز الكمية المتاحة (${availableQuantity})` });
        }
        if (inputItem.status === 'approved') {
          returnTotal += orderItem.price * returnItem.quantity;
          orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
          orderItem.returnReason = returnItem.reason;
          await Inventory.findOneAndUpdate(
            { branch: returnDoc.branch, product: returnItem.product },
            {
              $inc: { currentStock: returnItem.quantity },
              $push: {
                movements: {
                  type: 'return_approved',
                  quantity: returnItem.quantity,
                  reference: returnDoc.returnNumber,
                  createdBy: req.user.id,
                  createdAt: new Date().toISOString(),
                },
              },
            },
            { new: true, upsert: true, session }
          );
        }
        returnItem.status = inputItem.status;
        returnItem.reviewNotes = inputItem.reviewNotes?.trim();
      }

      // تحديث إجمالي الطلب
      order.adjustedTotal = order.adjustedTotal - returnTotal;
      if (order.adjustedTotal < 0) order.adjustedTotal = 0;
      const returnNote = `إرجاع (${returnDoc.returnNumber}) بقيمة ${returnTotal} ريال`;
      order.notes = order.notes ? `${order.notes}\n${returnNote}` : returnNote;
      order.returns = order.returns.map(r =>
        r._id.toString() === id
          ? { ...r, status: items.every(item => item.status === 'approved') ? 'approved' : items.every(item => item.status === 'rejected') ? 'rejected' : 'processed' }
          : r
      );
      order.markModified('items');
      await order.save({ session });

      // تحديث حالة الإرجاع
      returnDoc.status = items.every(item => item.status === 'approved') ? 'approved' : items.every(item => item.status === 'rejected') ? 'rejected' : 'processed';
      returnDoc.reviewedBy = req.user.id;
      returnDoc.reviewedAt = new Date().toISOString();
      returnDoc.statusHistory = returnDoc.statusHistory || [];
      returnDoc.statusHistory.push({
        status: returnDoc.status,
        changedBy: req.user.id,
        notes: items.map(item => item.reviewNotes).filter(Boolean).join('; '),
        changedAt: new Date().toISOString(),
      });
      returnDoc.markModified('items');
      await returnDoc.save({ session });

      // ملء البيانات
      const populatedReturn = await Return.findById(id)
        .populate('order', 'orderNumber totalAmount adjustedTotal branch')
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .populate('createdBy', 'username')
        .populate('reviewedBy', 'username')
        .session(session)
        .lean();

      // إرسال حدث Socket.IO
      const io = req.app.get('io');
      const returnData = {
        returnId: id,
        orderId: returnDoc.order._id,
        orderNumber: returnDoc.returnNumber,
        status: returnDoc.status,
        reviewNotes: items.map(item => item.reviewNotes).filter(Boolean).join('; '),
        branchId: returnDoc.branch,
        branchName: populatedReturn.branch?.name || 'Unknown',
        items: populatedReturn.items,
        createdAt: new Date(populatedReturn.createdAt).toISOString(),
        reviewedAt: new Date(populatedReturn.reviewedAt).toISOString(),
        adjustedTotal: order.adjustedTotal,
        eventId: `${id}-return_status_updated`,
      };
      const usersToNotify = await User.find({ 
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: returnDoc.branch }
        ]
      }).select('_id role branch').lean();
      for (const user of usersToNotify) {
        await require('../utils/notifications').createNotification(
          user._id,
          'return_status_updated',
          `تم ${returnDoc.status === 'approved' ? 'الموافقة' : returnDoc.status === 'rejected' ? 'الرفض' : 'معالجة'} طلب الإرجاع ${returnDoc.returnNumber} للطلب ${returnDoc.order.orderNumber}`,
          { returnId: id, orderId: returnDoc.order._id, orderNumber: returnDoc.returnNumber, branchId: returnDoc.branch, eventId: returnData.eventId },
          io
        );
      }
      io.of('/api').to(['admin', 'production', `branch-${returnDoc.branch}`]).emit('returnStatusUpdated', {
        ...returnData,
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      });

      await session.commitTransaction();
      console.log(`[${new Date().toISOString()}] Return ${returnDoc.status}: ${id}, User: ${req.user.id}`);
      res.status(200).json({
        ...populatedReturn,
        createdAt: new Date(populatedReturn.createdAt).toISOString(),
        reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error processing return:`, { error: err.message, userId: req.user.id });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// باقي المسارات كما هي
router.get('/:id/check', [
  auth,
  param('id').isMongoId().withMessage('Invalid order ID'),
], checkOrderExists);

router.post('/tasks', [
  auth,
  authorize('admin', 'production'),
  body('order').isMongoId().withMessage('Invalid order ID'),
  body('product').isMongoId().withMessage('Invalid product ID'),
  body('chef').isMongoId().withMessage('Invalid chef ID'),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('itemId').isMongoId().withMessage('Invalid itemId'),
], createTask);

router.get('/tasks', auth, getTasks);

router.get('/tasks/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage('Invalid chef ID'),
], getChefTasks);

router.post('/', [
  auth,
  authorize('branch'),
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
], createOrder);

router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage('Invalid order ID'),
], getOrderById);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
], updateOrderStatus);

router.patch('/:id/confirm-delivery', [
  auth,
  authorize('branch'),
  confirmDeliveryLimiter,
], confirmDelivery);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  body('status').isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid task status'),
], updateTaskStatus);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').isMongoId().withMessage('Invalid assignedTo'),
], assignChefs);

module.exports = router;