const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');
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
  try {
    session.startTransaction();
    const { orderNumber, items, status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Valid branch ID is required' });
    }
    if (!orderNumber || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing orderNumber or items:`, { orderNumber, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Order number and items array are required' });
    }

    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product)) {
        throw new Error(`Invalid product ID: ${item.product}`);
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
      statusHistory: [{ status, changedBy: req.user.id, changedAt: new Date() }],
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
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branchId: branch },
      ],
    }).select('_id role').lean();

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_created',
        `New order ${orderNumber} created by ${populatedOrder.createdBy?.username || 'Unknown'}`,
        {
          orderId: newOrder._id,
          orderNumber,
          branchId: branch,
          eventId: `${newOrder._id}-order_created`,
          path: '/orders',
        },
        io
      );
    }

    const orderData = {
      _id: newOrder._id,
      type: 'info',
      event: 'order_created',
      message: `New order ${orderNumber} created by ${populatedOrder.createdBy?.username || 'Unknown'}`,
      data: {
        orderId: newOrder._id,
        orderNumber,
        branchId: branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        adjustedTotal: populatedOrder.adjustedTotal,
        eventId: `${newOrder._id}-order_created`,
        path: '/orders',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'order_created', orderData);

    await session.commitTransaction();
    res.status(201).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
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
      .populate('items.assignedTo', 'username')
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
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    console.log(`[${new Date().toISOString()}] Fetching order by ID: ${id}, User: ${req.user.id}`);

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
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
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, items, notes } = req.body;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Valid order ID and items array are required' });
    }

    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for return: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Order must be in "delivered" status to create a return' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.product) || !item.quantity || !['defective', 'wrong_item', 'other'].includes(item.reason)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid return item:`, { item, userId: req.user.id });
        return res.status(400).json({ success: false, message: 'Invalid item data' });
      }
      const orderItem = order.items.find(i => i._id.toString() === item.itemId.toString());
      if (!orderItem || orderItem.product._id.toString() !== item.product.toString()) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order item not found or product mismatch:`, { itemId: item.itemId, product: item.product, userId: req.user.id });
        return res.status(400).json({ success: false, message: `Item ${item.itemId} not found or does not match the product` });
      }
      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { itemId: item.itemId, requested: item.quantity, available: orderItem.quantity - (orderItem.returnedQuantity || 0), userId: req.user.id });
        return res.status(400).json({ success: false, message: `Return quantity exceeds available quantity for item ${item.itemId}` });
      }
    }

    const newReturn = new Return({
      order: orderId,
      items: items.map(item => ({
        itemId: item.itemId,
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      status: 'pending_approval',
      createdBy: req.user.id,
      createdAt: new Date(),
      reviewNotes: notes?.trim(),
    });

    await newReturn.save({ session });

    order.returns.push(newReturn._id);
    await order.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branchId: order.branch },
      ],
    }).select('_id role').lean();

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `New return request created for order ${order.orderNumber}`,
        {
          returnId: newReturn._id,
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${newReturn._id}-return_status_updated`,
          path: '/returns',
        },
        io
      );
    }

    const returnData = {
      _id: newReturn._id,
      type: 'info',
      event: 'return_status_updated',
      message: `New return request created for order ${order.orderNumber}`,
      data: {
        returnId: newReturn._id,
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedReturn.order?.branch?.name || 'Unknown',
        eventId: `${newReturn._id}-return_status_updated`,
        path: '/returns',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'return_status_updated', returnData);

    await session.commitTransaction();
    res.status(201).json({
      ...populatedReturn,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid return ID' });
    }

    const returnRequest = await Return.findById(id).populate('order').populate('items.product').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Return not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return status: ${status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized return approval:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'Unauthorized to approve return' });
    }

    const order = await Order.findById(returnRequest.order._id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for return: ${returnRequest.order._id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    let adjustedTotal = order.adjustedTotal;
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Order item not found for return: ${returnItem.itemId}, User: ${req.user.id}`);
          return res.status(400).json({ success: false, message: `Item ${returnItem.itemId} not found in order` });
        }
        if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { itemId: returnItem.itemId, requested: returnItem.quantity, available: orderItem.quantity - (orderItem.returnedQuantity || 0), userId: req.user.id });
          return res.status(400).json({ success: false, message: `Return quantity exceeds available quantity for item ${returnItem.itemId}` });
        }
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        adjustedTotal -= returnItem.quantity * orderItem.price;
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'return',
                quantity: returnItem.quantity,
                reference: returnRequest._id,
                createdBy: req.user.id,
              },
            },
          },
          { upsert: true, session }
        );
      }
      order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;
      order.markModified('items');
      await order.save({ session });
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    await returnRequest.save({ session });

    const populatedOrder = await Order.findById(returnRequest.order._id)
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
        { role: 'branch', branchId: returnRequest.order?.branch },
      ],
    }).select('_id role').lean();

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `Return for order ${returnRequest.order?.orderNumber || 'Unknown'} ${status === 'approved' ? 'approved' : 'rejected'}`,
        {
          returnId: id,
          orderId: returnRequest.order?._id,
          orderNumber: returnRequest.order?.orderNumber,
          branchId: returnRequest.order?.branch,
          status,
          eventId: `${id}-return_status_updated`,
          path: '/returns',
        },
        io
      );
    }

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .lean();

    const returnData = {
      _id: id,
      type: status === 'approved' ? 'success' : 'warning',
      event: 'return_status_updated',
      message: `Return for order ${returnRequest.order?.orderNumber || 'Unknown'} ${status === 'approved' ? 'approved' : 'rejected'}`,
      data: {
        returnId: id,
        orderId: returnRequest.order?._id,
        orderNumber: returnRequest.order?.orderNumber,
        branchId: returnRequest.order?.branch,
        branchName: populatedReturn.order?.branch?.name || 'Unknown',
        status,
        eventId: `${id}-return_status_updated`,
        path: '/returns',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.order?.branch}`], 'return_status_updated', returnData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedReturn,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Valid order ID or items array required' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for assigning chefs: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Order must be in "approved" or "in_production" status to assign chefs' });
    }

    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));

    const io = req.app.get('io');
    const assignments = [];
    const taskAssignedEvents = [];

    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error(`Invalid IDs: ${itemId}, ${item.assignedTo}`);
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(`Item ${itemId} not found`);
      }

      const existingTask = await ProductionAssignment.findOne({ order: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        throw new Error('Cannot reassign task to another chef');
      }

      const chef = chefMap.get(item.assignedTo);
      const chefProfile = chefProfileMap.get(item.assignedTo);
      if (!chef || !chefProfile) {
        throw new Error('Invalid chef');
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      assignments.push(ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId },
        { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
        { upsert: true, session }
      ));

      taskAssignedEvents.push({
        _id: itemId,
        type: 'info',
        event: 'task_assigned',
        message: `New task assigned for ${orderItem.product.name} in order ${order.orderNumber}`,
        data: {
          orderId,
          itemId,
          taskId: existingTask?._id || `${itemId}-task`,
          status: 'pending',
          productName: orderItem.product.name,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          chefId: item.assignedTo,
          departmentId: orderItem.product.department?._id,
          eventId: `${itemId}-task_assigned`,
          path: '/production-tasks',
        },
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      });
    }

    await Promise.all(assignments);

    const usersToNotify = await User.find({ _id: { $in: items.map(i => i.assignedTo) } }).select('_id').lean();
    await Promise.all(usersToNotify.map(user =>
      createNotification(
        user._id,
        'task_assigned',
        `Assigned to produce item in order ${order.orderNumber}`,
        {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          chefId: user._id,
          eventId: `${orderId}-task_assigned`,
          path: '/production-tasks',
        },
        io
      )
    ));

    order.markModified('items');
    await order.save({ session });
    await syncOrderTasks(orderId, io, session);

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('returns')
      .lean();

    await Promise.all(taskAssignedEvents.map(event =>
      emitSocketEvent(io, [
        `chef-${event.data.chefId}`,
        `branch-${order.branch?._id}`,
        'production',
        'admin',
        `department-${event.data.departmentId}`,
      ], 'task_assigned', event)
    ));

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for approval: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Order is not in pending status' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized approval attempt:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'Unauthorized to approve order' });
    }

    order.status = 'approved';
    order.approvedBy = req.user.id;
    order.approvedAt = new Date();
    order.statusHistory.push({
      status: 'approved',
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

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_approved',
        `Order ${order.orderNumber} approved by ${req.user.username}`,
        {
          orderId: id,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${id}-order_approved`,
          path: '/orders',
        },
        io
      );
    }

    const orderData = {
      _id: id,
      type: 'success',
      event: 'order_approved',
      message: `Order ${order.orderNumber} approved by ${req.user.username}`,
      data: {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        adjustedTotal: populatedOrder.adjustedTotal,
        eventId: `${id}-order_approved`,
        path: '/orders',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'order_approved', orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const startTransit = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for transit: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Order must be in "completed" status to start transit' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized transit attempt:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'Unauthorized to start transit' });
    }

    order.status = 'in_transit';
    order.transitStartedAt = new Date();
    order.statusHistory.push({
      status: 'in_transit',
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

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_in_transit',
        `Order ${order.orderNumber} is in transit to ${populatedOrder.branch?.name || 'Unknown'}`,
        {
          orderId: id,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${id}-order_in_transit`,
          path: '/orders',
        },
        io
      );
    }

    const orderData = {
      _id: id,
      type: 'info',
      event: 'order_in_transit',
      message: `Order ${order.orderNumber} is in transit to ${populatedOrder.branch?.name || 'Unknown'}`,
      data: {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        adjustedTotal: populatedOrder.adjustedTotal,
        eventId: `${id}-order_in_transit`,
        path: '/orders',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'order_in_transit', orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for delivery confirmation: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Order must be in "in_transit" status to confirm delivery' });
    }

    if (req.user.role !== 'branch' || order.branch?.toString() !== req.user.branchId) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized delivery confirmation:`, { userId: req.user.id, role: req.user.role, userBranch: req.user.branchId, orderBranch: order.branch });
      return res.status(403).json({ success: false, message: 'Unauthorized to confirm delivery for this order' });
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

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_delivered',
        `Order ${order.orderNumber} delivered to ${populatedOrder.branch?.name || 'Unknown'}`,
        {
          orderId: id,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${id}-order_delivered`,
          path: '/orders',
        },
        io
      );
    }

    const orderData = {
      _id: id,
      type: 'success',
      event: 'order_delivered',
      message: `Order ${order.orderNumber} delivered to ${populatedOrder.branch?.name || 'Unknown'}`,
      data: {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        adjustedTotal: populatedOrder.adjustedTotal,
        eventId: `${id}-order_delivered`,
        path: '/orders',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'order_delivered', orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status transition:`, { current: order.status, new: status, userId: req.user.id });
      return res.status(400).json({ success: false, message: `Cannot transition from ${order.status} to ${status}` });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch, userId: req.user.id });return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
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

module.exports = {
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
};