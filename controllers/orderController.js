const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { createNotification } = require('../utils/notifications');
const { emitSocketEvent } = require('../utils/socketUtils');

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

const checkOrderExists = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in checkOrderExists:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { items, branch, priority, notes } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.error(`[${new Date().toISOString()}] Invalid items in createOrder:`, { userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Items are required' });
    }

    if (!isValidObjectId(branch)) {
      console.error(`[${new Date().toISOString()}] Invalid branch ID in createOrder: ${branch}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid branch ID' });
    }

    if (req.user.role === 'branch' && branch !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in createOrder:`, {
        userBranch: req.user.branchId,
        requestedBranch: branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    const productIds = items.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.error(`[${new Date().toISOString()}] Some products not found in createOrder:`, { userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Some products not found' });
    }

    const orderItems = items.map(item => {
      const product = products.find(p => p._id.toString() === item.product);
      if (!product) {
        throw new Error(`Product ${item.product} not found`);
      }
      return {
        product: item.product,
        quantity: item.quantity,
        price: product.price,
        unit: product.unit,
        status: 'pending',
      };
    });

    const total = orderItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    const order = new Order({
      orderNumber: `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      branch,
      items: orderItems,
      total,
      adjustedTotal: total,
      priority: priority || 'normal',
      notes: notes ? notes.trim() : '',
      createdBy: req.user.id,
      status: 'pending',
      statusHistory: [{ status: 'pending', changedBy: req.user.id, changedAt: new Date() }],
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(order._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branchId: branch },
      ],
    }).select('_id role branchId').lean();

    const message = `New order ${order.orderNumber} created`;
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'new_order_from_branch',
        message,
        {
          orderId: order._id,
          orderNumber: order.orderNumber,
          branchId: branch,
          path: '/orders',
        },
        io
      );
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'new_order_from_branch', {
      _id: order._id,
      type: 'success',
      event: 'new_order_from_branch',
      message,
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        branchId: branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        adjustedTotal: populatedOrder.adjustedTotal,
        path: '/orders',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: {
        ...populatedOrder,
        adjustedTotal: populatedOrder.adjustedTotal,
        createdAt: new Date(populatedOrder.createdAt).toISOString(),
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch, priority, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (priority) query.priority = priority;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    console.log(`[${new Date().toISOString()}] Fetching orders with query:`, {
      query,
      page,
      limit,
      userId: req.user.id,
      role: req.user.role,
    });

    const [orders, totalOrders] = await Promise.all([
      Order.find(query)
        .populate('branch', 'name')
        .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
        .populate('items.assignedTo', 'username')
        .populate('createdBy', 'username')
        .populate('returns')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(query),
    ]);

    console.log(`[${new Date().toISOString()}] Found ${orders.length} orders of ${totalOrders}`);

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

    res.status(200).json({
      success: true,
      orders: formattedOrders,
      pagination: {
        total: totalOrders,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalOrders / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in getOrderById: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in getOrderById: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in getOrderById:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    res.status(200).json({
      success: true,
      data: {
        ...order,
        adjustedTotal: order.adjustedTotal,
        createdAt: new Date(order.createdAt).toISOString(),
        approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
        transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
        deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by ID:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in updateOrderStatus: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in updateOrderStatus: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in updateOrderStatus:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    if (!validateStatusTransition(order.status, status)) {
      console.error(`[${new Date().toISOString()}] Invalid status transition in updateOrderStatus:`, {
        currentStatus: order.status,
        newStatus: status,
        userId: req.user.id,
      });
      return res.status(400).json({ success: false, message: 'Invalid status transition' });
    }

    order.status = status;
    order.notes = notes ? notes.trim() : order.notes;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    if (status === 'approved') {
      order.approvedBy = req.user.id;
      order.approvedAt = new Date();
    } else if (status === 'in_transit') {
      order.transitStartedAt = new Date();
    } else if (status === 'delivered') {
      order.deliveredAt = new Date();
    }

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branchId: order.branch },
      ],
    }).select('_id role').lean();

    const eventMap = {
      approved: 'order_approved',
      in_production: 'order_in_production',
      completed: 'order_completed',
      in_transit: 'order_in_transit',
      delivered: 'order_delivered',
      cancelled: 'order_cancelled',
    };

    const typeMap = {
      approved: 'success',
      in_production: 'info',
      completed: 'success',
      in_transit: 'info',
      delivered: 'success',
      cancelled: 'warning',
    };

    const event = eventMap[status] || 'order_updated';
    const notificationType = typeMap[status] || 'info';
    const message = `Order ${order.orderNumber} status updated to ${status}`;

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        event,
        message,
        {
          orderId: id,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${id}-${event}`,
          path: '/orders',
        },
        io
      );
    }

    const orderData = {
      _id: id,
      type: notificationType,
      event,
      message,
      data: {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        adjustedTotal: populatedOrder.adjustedTotal,
        eventId: `${id}-${event}`,
        path: '/orders',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], event, orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      approvedAt: populatedOrder.approvedAt ? new Date(populatedOrder.approvedAt).toISOString() : null,
      transitStartedAt: populatedOrder.transitStartedAt ? new Date(populatedOrder.transitStartedAt).toISOString() : null,
      deliveredAt: populatedOrder.deliveredAt ? new Date(populatedOrder.deliveredAt).toISOString() : null,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in assignChefs: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.error(`[${new Date().toISOString()}] Invalid items in assignChefs:`, { userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Items are required' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in assignChefs: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in assignChefs:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    const chefIds = items.map(item => item.assignedTo);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).select('_id').lean();
    if (chefs.length !== chefIds.length) {
      console.error(`[${new Date().toISOString()}] Some chefs not found in assignChefs:`, { userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Some chefs not found' });
    }

    for (const item of items) {
      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      if (!orderItem) {
        console.error(`[${new Date().toISOString()}] Item not found in assignChefs: ${item.itemId}, Order: ${id}, User: ${req.user.id}`);
        return res.status(400).json({ success: false, message: `Item ${item.itemId} not found` });
      }
      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'in_production';
    }

    await order.save({ session });

    const io = req.app.get('io');
    for (const item of items) {
      await createNotification(
        item.assignedTo,
        'new_production_assigned_to_chef',
        `New task assigned for order ${order.orderNumber}`,
        {
          orderId: order._id,
          orderNumber: order.orderNumber,
          itemId: item.itemId,
          path: '/production-tasks',
        },
        io
      );

      await emitSocketEvent(io, [`chef-${item.assignedTo}`], 'new_production_assigned_to_chef', {
        _id: order._id,
        type: 'info',
        event: 'new_production_assigned_to_chef',
        message: `New task assigned for order ${order.orderNumber}`,
        data: {
          orderId: order._id,
          orderNumber: order.orderNumber,
          itemId: item.itemId,
          path: '/production-tasks',
        },
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      });
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, message: 'Chefs assigned successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in confirmDelivery: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in confirmDelivery: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in confirmDelivery:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    if (order.status !== 'in_transit') {
      console.error(`[${new Date().toISOString()}] Invalid status for delivery confirmation: ${order.status}, Order: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Order must be in transit to confirm delivery' });
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branchId: order.branch },
      ],
    }).select('_id role').lean();

    const message = `Order ${order.orderNumber} delivered`;
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_delivered',
        message,
        {
          orderId: id,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          path: '/orders',
        },
        io
      );
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'order_delivered', {
      _id: id,
      type: 'success',
      event: 'order_delivered',
      message,
      data: {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        adjustedTotal: populatedOrder.adjustedTotal,
        path: '/orders',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      data: {
        ...populatedOrder,
        adjustedTotal: populatedOrder.adjustedTotal,
        createdAt: new Date(populatedOrder.createdAt).toISOString(),
        approvedAt: populatedOrder.approvedAt ? new Date(populatedOrder.approvedAt).toISOString() : null,
        transitStartedAt: populatedOrder.transitStartedAt ? new Date(populatedOrder.transitStartedAt).toISOString() : null,
        deliveredAt: populatedOrder.deliveredAt ? new Date(populatedOrder.deliveredAt).toISOString() : null,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid return ID in approveReturn: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid return ID' });
    }

    const returnDoc = await Return.findById(id).session(session);
    if (!returnDoc) {
      console.error(`[${new Date().toISOString()}] Return not found in approveReturn: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    const order = await Order.findById(returnDoc.order).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found for return in approveReturn: ${returnDoc.order}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in approveReturn:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    returnDoc.status = status;
    returnDoc.notes = notes ? notes.trim() : returnDoc.notes;
    returnDoc.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    if (status === 'approved') {
      returnDoc.approvedBy = req.user.id;
      returnDoc.approvedAt = new Date();
      for (const item of returnDoc.items) {
        const inventory = await Inventory.findOne({ product: item.product, branch: order.branch }).session(session);
        if (inventory) {
          inventory.quantity += item.quantity;
          await inventory.save({ session });
        } else {
          const newInventory = new Inventory({
            product: item.product,
            branch: order.branch,
            quantity: item.quantity,
          });
          await newInventory.save({ session });
        }
      }
    }

    await returnDoc.save({ session });

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branchId: order.branch },
      ],
    }).select('_id role').lean();

    const message = `Return for order ${order.orderNumber} status updated to ${status}`;
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        message,
        {
          orderId: order._id,
          orderNumber: order.orderNumber,
          returnId: id,
          branchId: order.branch,
          path: '/returns',
        },
        io
      );
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'return_status_updated', {
      _id: id,
      type: status === 'approved' ? 'success' : 'info',
      event: 'return_status_updated',
      message,
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        returnId: id,
        branchId: order.branch,
        path: '/returns',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, message: `Return status updated to ${status}` });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  approveReturn,
  assignChefs,
  confirmDelivery,
  updateOrderStatus,
  checkOrderExists,
};