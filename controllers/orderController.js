const mongoose = require('mongoose');
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

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

const notifyUsers = async (io, users, type, messageKey, data, saveToDb = false) => {
  const isRtl = data.isRtl ?? true;
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, status = 'pending', notes, notesEn, priority = 'medium', branchId, requestedDeliveryDate } = req.body;

    // Validate input
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;
    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الفرع مطلوب ويجب أن يكون صالحًا' : 'Branch ID is required and must be valid',
      });
    }

    if (!orderNumber || typeof orderNumber !== 'string' || !items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'رقم الطلب ومصفوفة العناصر مطلوبة ويجب أن تكون صالحة' : 'Order number and items array are required and must be valid',
      });
    }

    // Validate items
    for (const item of items) {
      if (!isValidObjectId(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1 || typeof item.price !== 'number' || item.price < 0) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'بيانات العنصر غير صالحة (معرف المنتج، الكمية، أو السعر)' : 'Invalid item data (product ID, quantity, or price)',
        });
      }
    }

    // Merge duplicate items
    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find(i => i.productId.toString() === item.productId.toString());
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        acc.push({
          productId: item.productId,
          productName: item.productName,
          productNameEn: item.productNameEn,
          quantity: item.quantity,
          price: item.price,
          unit: item.unit,
          unitEn: item.unitEn,
          department: item.department,
          status: 'pending',
        });
      }
      return acc;
    }, []);

    // Validate products
    const productIds = mergedItems.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('price name nameEn unit unitEn department')
      .populate('department', 'name nameEn')
      .lean()
      .session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found',
      });
    }

    // Validate prices
    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.productId.toString());
      if (product.price !== item.price) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `السعر غير متطابق للمنتج ${item.productId}` : `Price mismatch for product ${item.productId}`,
        });
      }
      item.productName = product.name;
      item.productNameEn = product.nameEn;
      item.unit = product.unit;
      item.unitEn = product.unitEn;
      item.department = product.department;
    }

    // Create new order
    const createdByUser = await User.findById(req.user.id).lean();
    const newOrder = new Order({
      orderNumber: orderNumber.trim(),
      branch,
      items: mergedItems,
      status,
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || notes?.trim() || '',
      priority,
      createdBy: req.user.id,
      createdByName: isRtl ? createdByUser.name : (createdByUser.nameEn || createdByUser.name),
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
      statusHistory: [{
        status,
        changedBy: req.user.id,
        changedByName: isRtl ? createdByUser.name : (createdByUser.nameEn || createdByUser.name),
        notes: notes?.trim() || (isRtl ? 'تم إنشاء الطلب' : 'Order created'),
        notesEn: notesEn?.trim() || 'Order created',
        changedAt: new Date(),
      }],
      isRtl,
    });

    // Check for unique order number
    const existingOrder = await Order.findOne({ orderNumber: newOrder.orderNumber, branch }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'رقم الطلب مستخدم بالفعل لهذا الفرع' : 'Order number already used for this branch',
      });
    }

    // Save order
    await newOrder.save({ session });
    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    // Populate order data
    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.productId', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .lean();

    // Notify users
    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean().session(session);

    const eventId = `${newOrder._id}-orderCreated`;
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    const branchNotificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      eventId,
      isRtl,
      type: 'toast',
    };

    await notifyUsers(
      io,
      branchUsers,
      'orderCreated',
      isRtl ? `تم إنشاء طلبك رقم ${newOrder.orderNumber} بنجاح` : `Order ${newOrder.orderNumber} created successfully`,
      branchNotificationData,
      false
    );

    const adminProductionNotificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      totalQuantity,
      totalAmount,
      items: populatedOrder.items.map(item => ({
        productId: item.productId?._id,
        productName: isRtl ? item.productName : (item.productNameEn || item.productName || 'Unknown'),
        quantity: item.quantity,
        price: item.price,
        unit: isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A'),
      })),
      status: newOrder.status,
      priority: newOrder.priority,
      requestedDeliveryDate: newOrder.requestedDeliveryDate ? new Date(newOrder.requestedDeliveryDate).toISOString() : null,
      eventId,
      isRtl,
      type: 'persistent',
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers],
      'orderCreated',
      isRtl
        ? `تم إنشاء طلب رقم ${newOrder.orderNumber} بقيمة ${totalAmount} وكمية ${totalQuantity} من فرع ${populatedOrder.branch?.name || 'غير معروف'}`
        : `Order ${newOrder.orderNumber} created with value ${totalAmount} and quantity ${totalQuantity} from branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      adminProductionNotificationData,
      true
    );

    const orderData = {
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.productName : (item.productNameEn || item.productName || 'Unknown'),
        unit: isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A'),
        departmentName: isRtl ? item.department?.name : (item.department?.nameEn || item.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: item.displayReturnReason,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'Unknown'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      requestedDeliveryDate: populatedOrder.requestedDeliveryDate ? new Date(populatedOrder.requestedDeliveryDate).toISOString() : null,
      eventId,
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'orderCreated', orderData);
    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: orderData,
      message: isRtl ? 'تم إنشاء الطلب بنجاح' : 'Order created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
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
    const order = await Order.findById(id).select('_id orderNumber status branch').setOptions({ context: { isRtl } }).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
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
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.productId', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .sort({ createdAt: -1 })
      .lean();

    const formattedOrders = orders.map(order => ({
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.productName : (item.productNameEn || item.productName || 'غير معروف'),
        unit: isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A'),
        departmentName: isRtl ? item.department?.name : (item.department?.nameEn || item.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: item.displayReturnReason,
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
    }));

    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
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
      .populate({ path: 'items.productId', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    const formattedOrder = {
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.productName : (item.productNameEn || item.productName || 'غير معروف'),
        unit: isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A'),
        departmentName: isRtl ? item.department?.name : (item.department?.nameEn || item.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: item.displayReturnReason,
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
    };

    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
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