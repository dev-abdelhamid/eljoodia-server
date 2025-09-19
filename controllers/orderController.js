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
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData });
};

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
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const checkOrderExists = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in checkOrderExists:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderNumber, items, status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing orderNumber or items:`, { orderNumber, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة' });
    }

    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product)) {
        throw new Error(`معرف المنتج غير صالح: ${item.product}`);
      }
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) existing.quantity += item.quantity;
      else acc.push({ ...item, status: 'pending', startedAt: null, completedAt: null });
      return acc;
    }, []);

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending',
      })),
      status,
      notes: notes?.trim(),
      priority,
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      statusHistory: [{ status, changedBy: req.user.id, changedAt: new Date().toISOString() }],
    });

    await newOrder.save({ session });
    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean();

    const eventId = `${newOrder._id}-orderCreated`;
    const eventData = {
      orderId: newOrder._id,
      orderNumber,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      eventId,
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'orderCreated',
      'socket.order_created',
      eventData
    );

    const orderData = {
      ...populatedOrder,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'orderCreated', orderData);

    await session.commitTransaction();
    res.status(201).json(orderData);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch, priority } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (priority) query.priority = priority;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    console.log(`[${new Date().toISOString()}] Fetching orders with query:`, { query, userId: req.user.id, role: req.user.role });

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username' , 'name')
      .populate('createdBy', 'username')
      .populate('returns')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`[${new Date().toISOString()}] Found ${orders.length} orders`);

    const formattedOrders = orders.map(order => ({
      ...order,
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      items: order.items.map(item => ({
        ...item,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
    }));

    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    console.log(`[${new Date().toISOString()}] Fetching order by ID: ${id}, User: ${req.user.id}`);

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username' , 'name')
      .populate('createdBy', 'username' )
      .populate('returns')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch?._id,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const formattedOrder = {
      ...order,
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      items: order.items.map(item => ({
        ...item,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
    };

    console.log(`[${new Date().toISOString()}] Order fetched successfully: ${id}`);
    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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