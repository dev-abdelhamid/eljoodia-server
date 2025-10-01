const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');
const { createReturn, approveReturn } = require('./returnController');
const { assignChefs, approveOrder, startTransit, confirmDelivery, updateOrderStatus, confirmOrderReceipt } = require('./statusController');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
};

const sendNotifications = async (io, users, rooms, type, messageKey, data, saveToDb = false) => {
  const eventId = data.eventId || uuidv4();
  const eventDataWithExtras = {
    ...data,
    sound: data.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: data.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId,
  };

  // إرسال إلى الغرف
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(type, eventDataWithExtras));

  // إشعار المستخدمين
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, eventDataWithExtras, io, saveToDb);
    } catch (err) {
      console.error(`Error notifying user ${user._id} for ${type}: ${err.message}`);
    }
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, status = 'pending', notes, notesEn, priority = 'medium', branchId, requestedDeliveryDate } = req.body;

    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;
    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع مطلوب ويجب أن يكون صالحًا' : 'Branch ID is required and must be valid' });
    }

    if (!orderNumber || typeof orderNumber !== 'string' || !items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'رقم الطلب ومصفوفة العناصر مطلوبة ويجب أن تكون صالحة' : 'Order number and items array are required and must be valid' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !Number.isInteger(item.quantity) || item.quantity < 1 || typeof item.price !== 'number' || item.price < 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data' });
      }
    }

    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        acc.push({ product: item.product, quantity: item.quantity, price: item.price, status: 'pending', startedAt: null, completedAt: null });
      }
      return acc;
    }, []);

    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).select('price name nameEn unit unitEn department').populate('department', 'name nameEn code').lean().session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.product.toString());
      if (product.price !== item.price) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `السعر غير متطابق للمنتج ${item.product}` : `Price mismatch for product ${item.product}` });
      }
    }

    const newOrder = new Order({
      orderNumber: orderNumber.trim(),
      branch,
      items: mergedItems,
      status,
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || notes?.trim() || '',
      priority: priority?.trim() || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
      statusHistory: [{
        status,
        changedBy: req.user.id,
        notes: notes?.trim() || (isRtl ? 'تم إنشاء الطلب' : 'Order created'),
        notesEn: notesEn?.trim() || 'Order created',
        changedAt: new Date(),
      }],
    });

    const existingOrder = await Order.findOne({ orderNumber: newOrder.orderNumber, branch }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'رقم الطلب مستخدم بالفعل' : 'Order number already used' });
    }

    await newOrder.save({ session, context: { isRtl } });
    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean().session(session);

    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    // إشعار الفرع (toast فقط، بدون حفظ)
    const branchData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : populatedOrder.branch?.nameEn || 'Unknown',
      isRtl,
      type: 'toast',
    };
    await sendNotifications(
      io,
      branchUsers,
      [`branch-${branch}`],
      'orderCreated',
      isRtl ? `تم إنشاء طلبك رقم ${newOrder.orderNumber} بنجاح` : `Order ${newOrder.orderNumber} created successfully`,
      branchData,
      false
    );

    // إشعار الإدمن والإنتاج (حفظ في DB)
    const adminProdData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : populatedOrder.branch?.nameEn || 'Unknown',
      totalQuantity,
      totalAmount,
      items: populatedOrder.items.map(item => ({
        productId: item.product?._id,
        productName: isRtl ? item.product?.name : item.product?.nameEn || 'Unknown',
        quantity: item.quantity,
        price: item.price,
        unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || 'N/A',
      })),
      status: newOrder.status,
      priority: newOrder.priority,
      requestedDeliveryDate: newOrder.requestedDeliveryDate ? new Date(newOrder.requestedDeliveryDate).toISOString() : null,
      isRtl,
      type: 'persistent',
    };
    await sendNotifications(
      io,
      [...adminUsers, ...productionUsers],
      ['admin', 'production'],
      'orderCreated',
      isRtl ? `تم إنشاء طلب رقم ${newOrder.orderNumber} بقيمة ${totalAmount} وكمية ${totalQuantity}` : `Order ${newOrder.orderNumber} created with value ${totalAmount} and quantity ${totalQuantity}`,
      adminProdData,
      true
    );

    // تنسيق البيانات للرد
    const orderData = {
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : populatedOrder.branch?.nameEn || 'Unknown',
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : item.product?.nameEn || 'Unknown',
        unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || 'N/A',
        departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || 'Unknown',
        assignedToName: isRtl ? item.assignedTo?.name : item.assignedTo?.nameEn || 'غير معين',
        displayReturnReason: item.displayReturnReason,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : populatedOrder.createdBy?.nameEn || 'Unknown',
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : history.changedBy?.nameEn || 'Unknown',
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      requestedDeliveryDate: populatedOrder.requestedDeliveryDate ? new Date(populatedOrder.requestedDeliveryDate).toISOString() : null,
      isRtl,
    };

    await session.commitTransaction();
    res.status(201).json({ success: true, data: orderData, message: isRtl ? 'تم إنشاء الطلب بنجاح' : 'Order created successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error creating order: ${err.message}`);
    res.status(500).json({ success: false, message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

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
    console.error(`Error checking order: ${err.message}`);
    res.status(500).json({ success: false, message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error' });
  }
};

const getOrders = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, branch, priority } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (priority) query.priority = priority;
    if (req.user.role === 'branch') query.branch = req.user.branchId; // production و admin يرون كل شيء
    const orders = await Order.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .sort({ createdAt: -1 })
      .lean();

    const formattedOrders = orders.map(order => ({
      ...order,
      branchName: isRtl ? order.branch?.name : order.branch?.nameEn || 'Unknown',
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : item.product?.nameEn || 'Unknown',
        unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || 'N/A',
        departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || 'Unknown',
        assignedToName: isRtl ? item.assignedTo?.name : item.assignedTo?.nameEn || 'غير معين',
        displayReturnReason: item.displayReturnReason,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : order.createdBy?.nameEn || 'Unknown',
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : history.changedBy?.nameEn || 'Unknown',
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
      isRtl,
    }));
    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`Error fetching orders: ${err.message}`);
    res.status(500).json({ success: false, message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error' });
  }
};

const getOrderById = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    // production يرى كل شيء مثل admin
    const formattedOrder = {
      ...order,
      branchName: isRtl ? order.branch?.name : order.branch?.nameEn || 'Unknown',
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : item.product?.nameEn || 'Unknown',
        unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || 'N/A',
        departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || 'Unknown',
        assignedToName: isRtl ? item.assignedTo?.name : item.assignedTo?.nameEn || 'غير معين',
        displayReturnReason: item.displayReturnReason,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : order.createdBy?.nameEn || 'Unknown',
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : history.changedBy?.nameEn || 'Unknown',
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
      isRtl,
    };
    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`Error fetching order: ${err.message}`);
    res.status(500).json({ success: false, message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error' });
  }
};

module.exports = {
  checkOrderExists,
  createOrder,
  getOrders,
  getOrderById,
  createReturn,
  approveReturn,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
};