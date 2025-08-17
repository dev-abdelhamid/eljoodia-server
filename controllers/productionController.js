const Order = require('../models/Order');
const { validationResult } = require('express-validator');
const { emitOrderEvent } = require('../utils/socket');

const createTask = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { order, product, chef, quantity, itemId } = req.body;

    const orderDoc = await Order.findById(order);
    if (!orderDoc) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const item = orderDoc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }

    item.product = product;
    item.assignedTo = chef;
    item.quantity = quantity;
    item.status = 'assigned';

    await orderDoc.save();
    await orderDoc.populate('branch createdBy items.product items.assignedTo');

    emitOrderEvent('taskAssigned', { orderId: orderDoc._id, items: [{ itemId, assignedTo: { _id: chef }, status: 'assigned' }] });

    res.json(orderDoc);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getTasks = async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query['items.status'] = status;

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

const getChefTasks = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { chefId } = req.params;

    const orders = await Order.find({ 'items.assignedTo': chefId })
      .populate('branch createdBy items.product items.assignedTo')
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { orderId, taskId } = req.params;
    const { status } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const item = order.items.id(taskId);
    if (!item) {
      return res.status(404).json({ message: 'Task not found' });
    }

    item.status = status;
    if (status === 'in_progress') item.startedAt = new Date();
    if (status === 'completed') item.completedAt = new Date();

    if (order.items.every((i) => i.status === 'completed') && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user._id,
        changedAt: new Date(),
      });
    }

    await order.save();
    await order.populate('branch createdBy items.product items.assignedTo');

    emitOrderEvent('taskStatusUpdated', { orderId, taskId, status });

    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
};
