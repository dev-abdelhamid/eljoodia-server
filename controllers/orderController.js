const mongoose = require('mongoose');
const { isValidObjectId } = require('mongoose');
const Order = mongoose.model('Order');
const Product = mongoose.model('Product');
const User = mongoose.model('User');
const ProductionAssignment = mongoose.model('ProductionAssignment');
const { createNotification } = require('./notifications');
const { syncOrderTasks } = require('./productionController');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  try {
    io.to(rooms).emit(eventName, eventData);
    console.log(`[${new Date().toISOString()}] Emitted ${eventName} to rooms: ${rooms.join(', ')}`, eventData);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error emitting ${eventName}: ${err.message}`);
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
      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items });
      return res.status(400).json({ success: false, message: 'Invalid order ID or items array' });
    }

    // Load data upfront
    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for assigning chefs: ${order.status}`);
      return res.status(400).json({ success: false, message: 'Order must be in "approved" or "in_production" status to assign chefs' });
    }

    // Load all required chefs and products
    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);
    const itemIds = items.map(item => item.itemId || item._id).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' })
      .populate('department')
      .lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).session(session).lean();
    const existingTasks = await ProductionAssignment.find({ order: orderId, itemId: { $in: itemIds } }).session(session).lean();

    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(cp => [cp.user.toString(), cp]));
    const existingTaskMap = new Map(existingTasks.map(t => [t.itemId.toString(), t]));

    const notifications = [];
    const taskAssignedEvents = [];
    const itemStatusEvents = [];
    const io = req.app.get('io');

    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid itemId or assignedTo:`, { itemId, assignedTo: item.assignedTo });
        return res.status(400).json({ success: false, message: 'Invalid itemId or assignedTo' });
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order item not found: ${itemId}`);
        return res.status(400).json({ success: false, message: `Item ${itemId} not found` });
      }

      const existingTask = existingTaskMap.get(itemId);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Attempt to reassign task:`, { taskId: existingTask._id, currentChef: existingTask.chef, newChef: item.assignedTo });
        return res.status(400).json({ success: false, message: 'Cannot reassign task to another chef' });
      }

      const chef = chefMap.get(item.assignedTo);
      const chefProfile = chefProfileMap.get(item.assignedTo);
      if (!chef || !chefProfile) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid chef:`, { chefId: item.assignedTo });
        return res.status(400).json({ success: false, message: 'Invalid chef' });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId },
        { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
        { upsert: true, session }
      );

      notifications.push({
        userId: item.assignedTo,
        type: 'task_assigned',
        message: `You have been assigned to produce ${orderItem.product.name} for order ${order.orderNumber}`,
        data: { taskId: itemId, orderId, orderNumber: order.orderNumber, branchId: order.branch?._id }
      });

      taskAssignedEvents.push({
        _id: itemId,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: orderItem.product._id, name: orderItem.product.name, department: orderItem.product.department },
        chef: { _id: item.assignedTo, username: chef.username || 'Unknown' },
        quantity: orderItem.quantity,
        itemId,
        status: 'pending',
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        sound: '/notification.mp3',
        vibrate: [400, 100, 400]
      });

      itemStatusEvents.push({
        orderId,
        itemId,
        status: 'assigned',
        productName: orderItem.product.name,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        sound: '/status-updated.mp3',
        vibrate: [200, 100, 200]
      });
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    // Send notifications and events in batch
    for (const notification of notifications) {
      await createNotification(notification, io);
    }

    for (const event of taskAssignedEvents) {
      await emitSocketEvent(io, [
        `chef-${event.chef._id}`,
        `branch-${event.branchId}`,
        'admin',
        'production'
      ], 'taskAssigned', event);
    }

    for (const event of itemStatusEvents) {
      await emitSocketEvent(io, [`branch-${event.branchId}`, 'admin', 'production'], 'itemStatusUpdated', event);
    }

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .lean();

    const orderData = {
      ...populatedOrder,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
      sound: '/order-updated.mp3',
      vibrate: [200, 100, 200]
    };
    await emitSocketEvent(io, [`branch-${order.branch?._id}`, 'admin', 'production'], 'orderUpdated', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  } finally {
    session.endSession();
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderNumber, branchId, items, status, notes, priority, requestedDeliveryDate } = req.body;
    const io = req.app.get('io');

    if (!isValidObjectId(branchId) || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branchId or items:`, { branchId, items });
      return res.status(400).json({ success: false, message: 'Invalid branch ID or items array' });
    }

    const branch = await mongoose.model('Branch').findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Branch not found: ${branchId}`);
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }

    const productIds = items.map(item => item.productId).filter(isValidObjectId);
    const products = await Product.find({ _id: { $in: productIds } })
      .populate('department')
      .lean();

    const productMap = new Map(products.map(p => [p._id.toString(), p]));
    for (const item of items) {
      if (!isValidObjectId(item.productId) || !productMap.has(item.productId)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid productId: ${item.productId}`);
        return res.status(400).json({ success: false, message: `Invalid product ID: ${item.productId}` });
      }
      if (!item.quantity || item.quantity < 1) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid quantity for product: ${item.productId}`);
        return res.status(400).json({ success: false, message: 'Quantity must be at least 1' });
      }
    }

    const order = new Order({
      orderNumber,
      branch: branchId,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        price: item.price || productMap.get(item.productId).price,
        status: 'pending',
        department: productMap.get(item.productId).department?._id
      })),
      status: status || 'pending',
      notes,
      priority,
      requestedDeliveryDate,
      statusHistory: [{ status: 'pending', changedBy: req.user.id, changedAt: new Date() }]
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(order._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .lean();

    const orderData = {
      ...populatedOrder,
      branchId: order.branch,
      branchName: branch.name || 'Unknown',
      sound: '/order-created.mp3',
      vibrate: [300, 100, 300]
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'orderCreated', orderData);
    await createNotification({
      title: `New Order: ${orderNumber}`,
      message: `New order created for branch ${branch.name || 'Unknown'}`,
      userId: req.user.id,
      role: ['admin', 'production'],
      branchId
    }, io);

    await session.commitTransaction();
    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch' && req.user.branchId) query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Order.countDocuments(query);
    res.status(200).json({
      orders,
      total,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, notes } = req.body;
    const io = req.app.get('io');

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    if (!['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    order.status = status;
    order.notes = notes || order.notes;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date()
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .lean();

    const orderData = {
      ...populatedOrder,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-updated.mp3',
      vibrate: [200, 100, 200]
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', orderData);
    await createNotification({
      title: `Order Status Updated: ${order.orderNumber}`,
      message: `Order ${order.orderNumber} status changed to ${status}`,
      userId: req.user.id,
      role: ['admin', 'production'],
      branchId: order.branch
    }, io);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const io = req.app.get('io');

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch });
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not in transit: ${id}, status: ${order.status}`);
      return res.status(400).json({ success: false, message: 'Order must be in transit to confirm delivery' });
    }

    order.status = 'delivered';
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      changedAt: new Date()
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .lean();

    const orderData = {
      ...populatedOrder,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-delivered.mp3',
      vibrate: [300, 100, 300]
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', orderData);
    await createNotification({
      title: `Order Delivered: ${order.orderNumber}`,
      message: `Order ${order.orderNumber} has been delivered to branch ${populatedOrder.branch?.name || 'Unknown'}`,
      userId: req.user.id,
      role: ['admin', 'production'],
      branchId: order.branch
    }, io);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
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
    const io = req.app.get('io');

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid returnId: ${id}`);
      return res.status(400).json({ success: false, message: 'Invalid return ID' });
    }

    if (!['pending_approval', 'approved', 'rejected', 'processed'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return status: ${status}`);
      return res.status(400).json({ success: false, message: 'Invalid return status' });
    }

    const returnDoc = await mongoose.model('Return').findById(id).session(session);
    if (!returnDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Return not found: ${id}`);
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    returnDoc.status = status;
    returnDoc.reviewNotes = reviewNotes || returnDoc.reviewNotes;
    await returnDoc.save({ session });

    const populatedReturn = await mongoose.model('Return').findById(id)
      .populate('order', 'orderNumber')
      .populate('items.product', 'name')
      .populate('branch', 'name')
      .lean();

    const returnData = {
      ...populatedReturn,
      branchId: returnDoc.branch,
      branchName: populatedReturn.branch?.name || 'Unknown',
      sound: '/return-updated.mp3',
      vibrate: [200, 100, 200]
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnDoc.branch}`], 'returnStatusUpdated', returnData);
    await createNotification({
      title: `Return Status Updated: ${populatedReturn.order?.orderNumber || 'Unknown'}`,
      message: `Return for order ${populatedReturn.order?.orderNumber || 'Unknown'} status changed to ${status}`,
      userId: req.user.id,
      role: ['admin', 'production'],
      branchId: returnDoc.branch
    }, io);

    await session.commitTransaction();
    res.status(200).json(populatedReturn);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, assignChefs, confirmDelivery, approveReturn };