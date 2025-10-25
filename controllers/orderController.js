const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const { createNotification } = require('../utils/notifications');
const { assignChefs, approveOrder, startTransit, updateOrderStatus, confirmOrderReceipt } = require('./statusController');

// دالة للتحقق من صحة ObjectId
const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// دالة لتحضير بيانات الطلب المعروضة
const prepareOrderResponse = (order, isRtl) => ({
  ...order,
  branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
  displayNotes: order.displayNotes,
  items: order.items.map(item => ({
    ...item,
    productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
    unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
    departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
    assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
    displayReturnReason: item.displayReturnReason,
    quantity: Number(item.quantity.toFixed(1)),
    startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
    completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
    isCompleted: item.status === 'completed',
  })),
  createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'غير معروف'),
  statusHistory: order.statusHistory.map(history => ({
    ...history,
    displayNotes: history.displayNotes,
    changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
    changedAt: new Date(history.changedAt).toISOString(),
  })),
  adjustedTotal: order.adjustedTotal,
  createdAt: new Date(order.createdAt).toISOString(),
  approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
  transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
  deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
  isRtl,
});

// دالة لإرسال أحداث السوكت
const emitSocketEvent = (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

// دالة لإشعار المستخدمين
const notifyUsers = async (io, users, type, message, data, saveToDb = false) => {
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }
};

// إنشاء طلب جديد
const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, status = 'pending', notes, notesEn, priority = 'medium', branchId, requestedDeliveryDate } = req.body;

    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;
    if (!branch || !orderNumber || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'رقم الطلب، الفرع، أو العناصر مفقودة' : 'Order number, branch, or items missing' });
    }

    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product)) {
        throw new Error(isRtl ? `معرف المنتج ${item.product} غير صالح` : `Invalid product ID ${item.product}`);
      }
      if (item.quantity <= 0) {
        throw new Error(isRtl ? `الكمية ${item.quantity} غير صالحة` : `Invalid quantity ${item.quantity}`);
      }
      if (item.price < 0) {
        throw new Error(isRtl ? `السعر ${item.price} غير صالح` : `Invalid price ${item.price}`);
      }
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        acc.push({ product: item.product, quantity: item.quantity, price: item.price, status: 'pending' });
      }
      return acc;
    }, []);

    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).select('price name nameEn unit unitEn department').populate('department').lean().session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.product.toString());
      if (product.price !== item.price) {
        throw new Error(isRtl ? `السعر ${item.price} غير متطابق للمنتج ${item.product}` : `Price ${item.price} does not match for product ${item.product}`);
      }
    }

    const newOrder = new Order({
      orderNumber: orderNumber.trim(),
      branch,
      items: mergedItems,
      status,
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || '',
      priority,
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
      statusHistory: [{ status, changedBy: req.user.id, notes: notes?.trim() || (isRtl ? 'تم إنشاء الطلب' : 'Order created'), notesEn: notesEn?.trim() || 'Order created', changedAt: new Date() }],
    });

    const existingOrder = await Order.findOne({ orderNumber: newOrder.orderNumber, branch }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'رقم الطلب مستخدم بالفعل' : 'Order number already used' });
    }

    await newOrder.save({ session });

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean().session(session);

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean().session(session);

    const eventId = `${newOrder._id}-orderCreated`;
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    const notificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || 'غير معروف'),
      totalQuantity,
      totalAmount,
      items: populatedOrder.items.map(item => ({
        productId: item.product?._id,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || 'غير معروف'),
        quantity: item.quantity,
        price: item.price,
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || 'N/A'),
      })),
      status,
      priority,
      eventId,
      isRtl,
    };

    await notifyUsers(io, branchUsers, 'orderCreated', isRtl ? `تم إنشاء طلبك رقم ${newOrder.orderNumber}` : `Order ${newOrder.orderNumber} created`, { ...notificationData, type: 'toast' }, false);
    await notifyUsers(io, [...adminUsers, ...productionUsers], 'orderCreated', isRtl ? `طلب جديد ${newOrder.orderNumber}` : `New order ${newOrder.orderNumber}`, { ...notificationData, type: 'persistent' }, true);
    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'orderCreated', prepareOrderResponse(populatedOrder, isRtl));

    await session.commitTransaction();
    res.status(201).json({ success: true, data: prepareOrderResponse(populatedOrder, isRtl), message: isRtl ? 'تم إنشاء الطلب' : 'Order created' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// جلب جميع الطلبات
const getOrders = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, branch, priority } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (priority) query.priority = priority;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .sort({ createdAt: -1 })
      .lean();

    const formattedOrders = orders.map(order => prepareOrderResponse(order, isRtl));
    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// جلب طلب بناءً على المعرف
const getOrderById = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    res.status(200).json(prepareOrderResponse(order, isRtl));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// التحقق من وجود الطلب
const checkOrderExists = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  checkOrderExists,
};