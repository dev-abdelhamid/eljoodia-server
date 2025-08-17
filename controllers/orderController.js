const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const Notification = require('../models/Notification');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['cancelled', 'completed'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
};

const createNotification = async (to, type, message, data, io) => {
  try {
    const notification = new Notification({
      user: to,
      type,
      message,
      data,
      read: false,
    });
    await notification.save();
    io.to(`user-${to}`).emit('newNotification', notification);
    console.log(`Notification sent to user-${to} at ${new Date().toISOString()}: ${message}`);
    return notification;
  } catch (err) {
    console.error(`Error creating notification for user-${to}: ${err.message}`);
    throw err;
  }
};

const createOrder = async (req, res) => {
  try {
    const { orderNumber, items, status, notes, priority, branchId } = req.body;
    let branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      return res.status(400).json({ success: false, message: 'Valid branch ID is required' });
    }
    if (!orderNumber || !items?.length) {
      return res.status(400).json({ success: false, message: 'Order number and items array are required' });
    }

    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find((i) => i.productId.toString() === item.productId.toString());
      if (existing) existing.quantity += item.quantity;
      else acc.push(item);
      return acc;
    }, []);

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map((item) => ({
        product: item.productId,
        quantity: item.quantity,
        price: item.price,
        status: 'pending',
      })),
      status: status || 'pending',
      notes: notes?.trim(),
      priority: priority || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
    });

    await newOrder.save();
    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .lean();

    const notifyRoles = ['production', 'admin'];
    const usersToNotify = await User.find({ role: { $in: notifyRoles } }).select('_id');
    const io = req.app.get('io');
    for (const user of usersToNotify) {
      await createNotification(user._id, 'order_created', `New order ${orderNumber} created by branch ${populatedOrder.branch.name}`, { orderId: newOrder._id }, io);
    }

    io.to(branch.toString()).emit('orderCreated', populatedOrder);
    io.to('admin').emit('orderCreated', populatedOrder);
    io.to('production').emit('orderCreated', populatedOrder);
    res.status(201).json(populatedOrder);
  } catch (err) {
    console.error(`Error creating order at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(orders);
  } catch (err) {
    console.error(`Error fetching orders at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (!validateStatusTransition(order.status, status)) {
      return res.status(400).json({ success: false, message: `Invalid status transition from ${order.status} to ${status}` });
    }

    order.status = status;
    if (notes) order.notes = notes.trim();
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes,
      changedAt: new Date(),
    });
    await order.save();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    const notifyRoles = {
      approved: ['production'],
      in_production: ['chef', 'branch'],
      completed: ['branch', 'admin'],
      in_transit: ['branch', 'admin'],
      cancelled: ['branch', 'production', 'admin'],
    }[status] || [];

    if (notifyRoles.length > 0) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch }).select('_id');
      const io = req.app.get('io');
      for (const user of usersToNotify) {
        await createNotification(user._id, 'order_status_updated', `Order ${order.orderNumber} status updated to ${status}`, { orderId: id }, io);
      }
    }

    const io = req.app.get('io');
    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    io.to('admin').emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    io.to('production').emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error updating order status at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const confirmDelivery = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch');
    if (!order || order.status !== 'in_transit') {
      return res.status(400).json({ success: false, message: 'Order must be in transit' });
    }

    if (req.user.role === 'branch' && order.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    for (const item of order.items) {
      await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        { $inc: { currentStock: item.quantity } },
        { upsert: true }
      );
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({ status: 'delivered', changedBy: req.user.id });
    await order.save();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] }, branchId: order.branch }).select('_id');
    const io = req.app.get('io');
    for (const user of usersToNotify) {
      await createNotification(user._id, 'order_delivered', `Order ${order.orderNumber} delivered to branch ${order.branch.name}`, { orderId: id }, io);
    }

    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status: 'delivered', user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error confirming delivery at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const approveReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid return ID' });
    }

    const returnRequest = await Return.findById(id).populate('order');
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    if (status === 'approved') {
      for (const item of returnRequest.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order.branch, product: item.product },
          { $inc: { currentStock: -item.quantity } },
          { upsert: true }
        );
      }
    }

    returnRequest.status = status;
    if (reviewNotes) returnRequest.reviewNotes = reviewNotes.trim();
    await returnRequest.save();

    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order.branch }).select('_id');
    const io = req.app.get('io');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `Return for order ${returnRequest.order.orderNumber} ${status === 'approved' ? 'approved' : 'rejected'}`,
        { returnId: id, orderId: returnRequest.order._id },
        io
      );
    }

    io.to(returnRequest.order.branch.toString()).emit('returnStatusUpdated', { returnId: id, status, reviewNotes });
    res.status(200).json(returnRequest);
  } catch (err) {
    console.error(`Error approving return at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const assignChefs = async (req, res) => {
  try {
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }
    if (!items?.length) {
      return res.status(400).json({ success: false, message: 'Items array is required' });
    }

    const order = await Order.findById(orderId)
      .populate({
        path: 'items.product',
        populate: { path: 'department', select: 'name code isActive' },
      })
      .populate('branch');
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized for this branch' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        return res.status(400).json({ success: false, message: `Invalid IDs for item ${item.itemId}` });
      }

      const orderItem = order.items.id(item.itemId);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: `Item ${item.itemId} not found in order` });
      }

      const chef = await User.findById(item.assignedTo).populate('department');
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo });
      if (!chef || chef.role !== 'chef' || !chefProfile) {
        return res.status(400).json({ success: false, message: `Invalid chef ${item.assignedTo}` });
      }

      const product = orderItem.product;
      if (!product || !product.department) {
        return res.status(400).json({ success: false, message: `Product ${orderItem.product.name} has no department` });
      }
      if (chef.department._id.toString() !== product.department._id.toString()) {
        return res.status(400).json({ success: false, message: `Chef ${chef.username} does not match department ${product.department.name}` });
      }

      if (!chef.isActive) {
        return res.status(400).json({ success: false, message: `Chef ${chef.username} is not active` });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      const assignment = await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId: item.itemId },
        { chef: chefProfile._id, product: product._id, quantity: orderItem.quantity, status: 'pending' },
        { upsert: true, new: true }
      );

      const io = req.app.get('io');
      await createNotification(
        item.assignedTo,
        'task_assigned',
        `Assigned to produce ${product.name} for order ${order.orderNumber}`,
        { taskId: assignment._id, orderId },
        io
      );
    }

    order.status = order.items.every((i) => i.status === 'assigned') ? 'in_production' : order.status;
    if (order.isModified('status')) {
      order.statusHistory.push({ status: order.status, changedBy: req.user.id, changedAt: new Date() });
      const usersToNotify = await User.find({ role: { $in: ['chef', 'admin'] } }).select('_id');
      const io = req.app.get('io');
      for (const user of usersToNotify) {
        await createNotification(user._id, 'order_status_updated', `Order ${order.orderNumber} production started`, { orderId }, io);
      }
      io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId, status: order.status, user: req.user });
    }

    await order.save();

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .lean();

    const io = req.app.get('io');
    io.to(order.branch.toString()).emit('taskAssigned', {
      orderId,
      items: items.map((item) => ({
        _id: item.itemId,
        assignedTo: { _id: item.assignedTo, username: populatedOrder.items.find((i) => i._id.toString() === item.itemId).assignedTo.username },
        status: 'assigned',
      })),
    });

    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error assigning chefs at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const createTask = async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!isValidObjectId(order) || !isValidObjectId(product) || !isValidObjectId(chef) || !quantity || quantity < 1) {
      return res.status(400).json({ success: false, message: 'Valid order, product, chef, and quantity are required' });
    }

    const orderDoc = await Order.findById(order);
    if (!orderDoc) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    let orderItem;
    if (itemId && isValidObjectId(itemId)) {
      orderItem = orderDoc.items.id(itemId);
      if (!orderItem || orderItem.product.toString() !== product) {
        return res.status(400).json({ success: false, message: 'Item or product not found in order' });
      }
    } else {
      orderItem = orderDoc.items.find((i) => i.product.toString() === product);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: 'Product not found in order' });
      }
    }

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
      itemId: orderItem._id,
      status: 'pending',
    });

    await newAssignment.save();

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    await orderDoc.save();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    io.to(`chef-${chef}`).emit('taskAssigned', populatedAssignment);
    io.to('admin').emit('taskAssigned', populatedAssignment);
    io.to('production').emit('taskAssigned', populatedAssignment);
    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error(`Error creating task at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`Error fetching tasks at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'Invalid chef ID' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`Error fetching chef tasks at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid order or task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order');
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized to update this task' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid task status' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      return res.status(400).json({ success: false, message: `Item ${task.itemId} not found in order` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    const allItemsCompleted = order.items.every((i) => i.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({ status: 'completed', changedBy: req.user.id, changedAt: new Date() });
      await order.save();
      io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId, status: 'completed', user: req.user });
    }
    await order.save();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber status')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', { taskId, status, orderId });
    io.to(order.branch.toString()).emit('taskStatusUpdated', { taskId, status, orderId });
    io.to('admin').emit('taskStatusUpdated', { taskId, status, orderId });
    io.to('production').emit('taskStatusUpdated', { taskId, status, orderId });
    if (status === 'completed') {
      io.to(`chef-${task.chef}`).emit('taskCompleted', { orderId, taskId });
      io.to(order.branch.toString()).emit('taskCompleted', { orderId, taskId });
      io.to('admin').emit('taskCompleted', { orderId, taskId });
      io.to('production').emit('taskCompleted', { orderId, taskId });
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`Error updating task status at ${new Date().toISOString()}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, confirmDelivery, approveReturn, assignChefs, createTask, getTasks, getChefTasks, updateTaskStatus };