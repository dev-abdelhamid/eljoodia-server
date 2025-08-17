const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const Notification = require('../models/Notification');
const Chef = require('../models/Chef');

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
      createdAt: new Date(),
    });
    await notification.save();
    io.to(`user-${to}`).emit('newNotification', notification);
    console.log(`Notification sent to user-${to} at ${new Date().toISOString()}:`, { type, message });
    return notification;
  } catch (err) {
    console.error(`Error creating notification for user-${to} at ${new Date().toISOString()}:`, err);
    throw err;
  }
};

const createOrder = async (req, res) => {
  try {
    const { orderNumber, items, status = 'pending', notes, priority, branchId } = req.body;
    let branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      return res.status(400).json({ success: false, message: 'Branch ID is required and must be valid' });
    }
    if (!orderNumber || !items?.length) {
      return res.status(400).json({ success: false, message: 'Order number and items array are required' });
    }

    // Merge duplicate items
    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product)) {
        throw new Error(`Invalid product ID: ${item.product}`);
      }
      const existing = acc.find((i) => i.product.toString() === item.product.toString());
      if (existing) {
        existing.quantity += item.quantity;
        existing.price = Math.max(existing.price || 0, item.price || 0);
      } else {
        acc.push({ ...item, status: 'pending' });
      }
      return acc;
    }, []);

    // Validate products
    const productIds = mergedItems.map((item) => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).select('name price department');
    if (products.length !== productIds.length) {
      return res.status(400).json({ success: false, message: 'One or more products not found' });
    }

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map((item) => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending',
      })),
      status,
      notes: notes?.trim(),
      priority: priority || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      createdAt: new Date(),
    });

    await newOrder.save();

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name code')
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
      await createNotification(
        user._id,
        'order_created',
        `New order ${orderNumber} created by branch ${populatedOrder.branch.name}`,
        { orderId: newOrder._id },
        io
      );
    }

    io.to(branch.toString()).emit('orderCreated', populatedOrder);
    res.status(201).json(populatedOrder);
  } catch (err) {
    console.error(`Error creating order at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { createdAt: -1 },
      populate: [
        { path: 'branch', select: 'name code' },
        {
          path: 'items.product',
          select: 'name price unit department',
          populate: { path: 'department', select: 'name code' },
        },
        { path: 'items.assignedTo', select: 'username' },
        { path: 'createdBy', select: 'username' },
      ],
      lean: true,
    };

    const orders = await Order.paginate(query, options);
    orders.docs.forEach((order) => {
      order.items.forEach((item) => {
        item.isCompleted = item.status === 'completed';
      });
    });

    res.status(200).json(orders);
  } catch (err) {
    console.error(`Error fetching orders at ${new Date().toISOString()}:`, err);
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
      .populate('branch', 'name code')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    let notifyRoles = [];
    if (status === 'approved') notifyRoles = ['production'];
    if (status === 'in_production') notifyRoles = ['chef', 'branch'];
    if (status === 'completed') notifyRoles = ['branch', 'admin'];
    if (status === 'in_transit') notifyRoles = ['branch', 'admin'];
    if (status === 'cancelled') notifyRoles = ['branch', 'production', 'admin'];

    if (notifyRoles.length > 0) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch }).select('_id');
      const io = req.app.get('io');
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `Order ${order.orderNumber} status updated to ${status}`,
          { orderId: id },
          io
        );
      }
    }

    const io = req.app.get('io');
    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error updating order status at ${new Date().toISOString()}:`, err);
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
      return res.status(400).json({ success: false, message: 'Order must be in_transit to confirm delivery' });
    }

    if (req.user.role === 'branch' && order.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized for this branch' });
    }

    // Update inventory
    const inventoryUpdates = order.items.map(async (item) => {
      return Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        { $inc: { currentStock: item.quantity } },
        { upsert: true, new: true }
      );
    });
    await Promise.all(inventoryUpdates);

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({ status: 'delivered', changedBy: req.user.id, changedAt: new Date() });
    await order.save();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name code')
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
      await createNotification(
        user._id,
        'order_delivered',
        `Order ${order.orderNumber} delivered to branch ${order.branch.name}`,
        { orderId: id },
        io
      );
    }

    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status: 'delivered', user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error confirming delivery at ${new Date().toISOString()}:`, err);
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

    const returnRequest = await Return.findById(id).populate('order').populate('items.product');
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: 'Return request not found' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    if (status === 'approved') {
      const inventoryUpdates = returnRequest.items.map(async (item) => {
        return Inventory.findOneAndUpdate(
          { branch: returnRequest.order.branch, product: item.product },
          { $inc: { currentStock: -item.quantity } },
          { upsert: true, new: true }
        );
      });
      await Promise.all(inventoryUpdates);
    }

    returnRequest.status = status;
    if (reviewNotes) returnRequest.reviewNotes = reviewNotes.trim();
    returnRequest.updatedAt = new Date();
    await returnRequest.save();

    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order.branch }).select('_id');
    const io = req.app.get('io');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `Return request for order ${returnRequest.order.orderNumber} ${status === 'approved' ? 'approved' : 'rejected'}`,
        { returnId: id, orderId: returnRequest.order._id },
        io
      );
    }

    io.to(returnRequest.order.branch.toString()).emit('returnStatusUpdated', { returnId: id, status });
    res.status(200).json(returnRequest);
  } catch (err) {
    console.error(`Error approving return at ${new Date().toISOString()}:`, err);
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

    const assignments = [];
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        return res.status(400).json({ success: false, message: `Invalid IDs for item ${item.itemId}` });
      }

      const orderItem = order.items.id(item.itemId);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: `Item ${item.itemId} not found in order` });
      }

      const chefProfile = await Chef.findOne({ user: item.assignedTo });
      if (!chefProfile) {
        return res.status(400).json({ success: false, message: `Chef ${item.assignedTo} not found` });
      }

      const user = await User.findById(item.assignedTo).populate('department');
      if (!user || user.role !== 'chef' || !user.department) {
        return res.status(400).json({ success: false, message: `Invalid chef ${item.assignedTo}` });
      }

      const product = orderItem.product;
      if (!product || !product.department) {
        return res.status(400).json({ success: false, message: `Product ${orderItem.product.name} has no department` });
      }
      if (user.department._id.toString() !== product.department._id.toString()) {
        return res.status(400).json({ success: false, message: `Chef ${user.username} does not match department ${product.department.name}` });
      }

      if (!user.isActive) {
        return res.status(400).json({ success: false, message: `Chef ${user.username} is not active` });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      const assignment = await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId: item.itemId },
        {
          chef: chefProfile._id,
          product: product._id,
          quantity: orderItem.quantity,
          status: 'pending',
          createdAt: new Date(),
        },
        { upsert: true, new: true }
      );

      assignments.push(assignment);

      const io = req.app.get('io');
      await createNotification(
        item.assignedTo,
        'task_assigned',
        `You have been assigned to produce ${product.name} for order ${order.orderNumber}`,
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
        await createNotification(
          user._id,
          'order_status_updated',
          `Order ${order.orderNumber} production started`,
          { orderId },
          io
        );
      }
      io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId, status: order.status, user: req.user });
    }

    await order.save();

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name code')
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
    console.error(`Error assigning chefs at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, confirmDelivery, approveReturn, assignChefs };