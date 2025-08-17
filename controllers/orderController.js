const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { validationResult } = require('express-validator');
const { emitOrderEvent } = require('../socket');

const createOrder = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { items, notes, priority, requestedDeliveryDate } = req.body;
    const user = req.user;

    // Validate products and calculate total amount
    const populatedItems = await Promise.all(
      items.map(async (item) => {
        const product = await Product.findById(item.product);
        if (!product) {
          throw new Error(`Product ${item.product} not found`);
        }
        return {
          product: item.product,
          quantity: item.quantity,
          price: product.price || item.price,
          status: 'pending',
        };
      })
    );

    const totalAmount = populatedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    const order = new Order({
      orderNumber: `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      branch: user.branchId,
      items: populatedItems,
      totalAmount,
      notes,
      priority: priority || 'medium',
      requestedDeliveryDate,
      createdBy: user._id,
      status: 'pending',
      statusHistory: [{ status: 'pending', changedBy: user._id, changedAt: new Date() }],
    });

    await order.save();
    await order.populate('branch items.product createdBy');

    emitOrderEvent('orderCreated', order);

    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, department, page = 1, limit = 10 } = req.query;
    const query = {};

    if (status) query.status = status;
    if (req.user.role === 'production' && req.user.department) {
      query['items.department'] = req.user.department;
    } else if (department) {
      query['items.department'] = department;
    }

    const orders = await Order.find(query)
      .populate('branch createdBy items.product items.assignedTo')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Order.countDocuments(query);

    res.json({ data: orders, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { status } = req.body;
    const user = req.user;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const validTransitions = {
      pending: ['approved', 'cancelled'],
      approved: ['in_production', 'cancelled'],
      in_production: ['completed', 'cancelled'],
      completed: ['in_transit'],
      in_transit: ['delivered'],
      delivered: [],
      cancelled: [],
    };

    if (!validTransitions[order.status].includes(status)) {
      return res.status(400).json({ message: 'Invalid status transition' });
    }

    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: user._id,
      changedAt: new Date(),
    });

    if (status === 'approved') order.approvedBy = user._id;
    if (status === 'delivered') order.deliveredAt = new Date();

    await order.save();
    await order.populate('branch createdBy items.product items.assignedTo');

    emitOrderEvent('orderStatusUpdated', { orderId: order._id, status, user });

    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const assignChefs = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { items } = req.body;
    const user = req.user;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!['approved', 'in_production'].includes(order.status)) {
      return res.status(400).json({ message: 'Order must be approved or in production to assign chefs' });
    }

    for (const assignment of items) {
      const item = order.items.id(assignment.itemId);
      if (!item) {
        return res.status(404).json({ message: `Item ${assignment.itemId} not found` });
      }
      const chef = await User.findById(assignment.assignedTo);
      if (!chef || chef.role !== 'chef') {
        return res.status(400).json({ message: `Invalid chef ${assignment.assignedTo}` });
      }
      item.assignedTo = assignment.assignedTo;
      item.status = 'assigned';
    }

    if (order.items.every((item) => item.status === 'assigned')) {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: user._id,
        changedAt: new Date(),
      });
    }

    await order.save();
    await order.populate('branch createdBy items.product items.assignedTo');

    emitOrderEvent('taskAssigned', { orderId: order._id, items });

    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const confirmDelivery = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.status !== 'in_transit') {
      return res.status(400).json({ message: 'Order must be in transit to confirm delivery' });
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user._id,
      changedAt: new Date(),
    });

    await order.save();
    await order.populate('branch createdBy items.product items.assignedTo');

    emitOrderEvent('orderStatusUpdated', { orderId: order._id, status: 'delivered', user: req.user });

    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const approveReturn = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    const order = await Order.findOne({ 'returns._id': id });
    if (!order) {
      return res.status(404).json({ message: 'Return not found' });
    }

    const returnItem = order.returns.id(id);
    if (!returnItem) {
      return res.status(404).json({ message: 'Return not found' });
    }

    returnItem.status = status;
    if (reviewNotes) returnItem.reviewNotes = reviewNotes;

    await order.save();
    await order.populate('branch createdBy items.product items.assignedTo returns.items.product');

    emitOrderEvent('returnStatusUpdated', { orderId: order._id, returnId: id, status });

    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  approveReturn,
};
