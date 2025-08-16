const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { Server } = require('socket.io');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper function to validate status transitions
const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: ['in_transit', 'delivered'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
};

// Setup Socket.IO (must also be configured in the main server file)
const io = new Server({
  cors: {
    origin: ['http://localhost:3000', 'https://eljoodia-production.up.railway.app'],
    methods: ['GET', 'POST'],
  },
});

const createOrder = async (req, res) => {
  try {
    const { orderNumber, items, status, notes, priority, branchId } = req.body;
    let branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      return res.status(400).json({ success: false, message: 'Branch ID is required and must be valid' });
    }
    if (!orderNumber || !items?.length) {
      return res.status(400).json({ success: false, message: 'Order number and items array are required' });
    }

    const newOrder = new Order({
      orderNumber,
      branch,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending',
      })),
      status: 'pending', // Default status
      notes: notes?.trim(),
      priority: priority || 'medium',
      createdBy: req.user.id,
      totalAmount: items.reduce((sum, item) => sum + item.quantity * item.price, 0),
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

    io.to(branch.toString()).emit('orderCreated', populatedOrder);
    res.status(201).json(populatedOrder);
  } catch (err) {
    console.error('Error creating order:', err);
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
    console.error('Error fetching orders:', err);
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
      return res.status(400).json({ success: false, message: `Transition from ${order.status} to ${status} is not allowed` });
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

    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('Error updating order status:', err);
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
      return res.status(403).json({ success: false, message: 'Not authorized for this branch' });
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

    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status: 'delivered', user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('Error confirming delivery:', err);
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

    io.to(returnRequest.order.branch.toString()).emit('returnStatusUpdated', { returnId: id, status });
    res.status(200).json(returnRequest);
  } catch (err) {
    console.error('Error approving return:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'Chef profile not found' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefProfile._id })
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error('Error fetching chef tasks:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { taskId } = req.params;

    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order');
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this task' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(task.order._id);
    if (order) {
      const orderItem = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (orderItem) {
        orderItem.status = status;
        if (status === 'in_progress') orderItem.startedAt = new Date();
        if (status === 'completed') orderItem.completedAt = new Date();
      }

      const allAssignments = await ProductionAssignment.find({ order: task.order });
      const allTasksCompleted = allAssignments.every(a => a.status === 'completed');
      const allOrderItemsCompleted = order.items.every(i => i.status === 'completed');

      if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
        order.status = 'completed';
        order.statusHistory.push({ status: 'completed', changedBy: req.user.id });
        await order.save();
        io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: order._id, status: 'completed' });
      } else {
        await order.save();
      }
    }

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .lean();

    io.to(order.branch.toString()).emit('taskStatusUpdated', { taskId, status });
    res.status(200).json(populatedTask);
  } catch (err) {
    console.error('Error updating task status:', err);
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
      return res.status(403).json({ success: false, message: 'Not authorized for this branch' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        return res.status(400).json({ success: false, message: 'Invalid IDs' });
      }

      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: 'Item not found in order' });
      }

      const chef = await User.findById(item.assignedTo).populate('department');
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo });
      const product = await Product.findById(orderItem.product).populate('department');

      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department._id.toString() !== product.department._id.toString()) {
        return res.status(400).json({ success: false, message: 'Invalid chef or department mismatch' });
      }

      order.items = order.items.map(i =>
        i._id.toString() === item.itemId ? { ...i, assignedTo: item.assignedTo, status: 'assigned' } : i
      );

      await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId: item.itemId },
        { chef: chefProfile._id, status: 'pending' },
        { upsert: true }
      );
    }

    order.status = order.items.every(i => i.status === 'assigned') ? 'in_production' : order.status;
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

    io.to(order.branch.toString()).emit('orderUpdated', populatedOrder);
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('Error assigning chefs:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, confirmDelivery, approveReturn, getChefTasks, updateTaskStatus, assignChefs };