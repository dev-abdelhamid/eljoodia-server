const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Chef = require('../models/Chef');
const mongoose = require('mongoose');

router.post('/', authMiddleware.auth, authMiddleware.authorize('admin', 'manager'), async (req, res) => {
  try {
    const { order, product, chef, quantity } = req.body;

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1) {
      return res.status(400).json({ message: 'Order, product, chef, and valid quantity are required' });
    }

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
    });

    await newAssignment.save();
    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error('Create production assignment error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const assignments = await ProductionAssignment.find()
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json(assignments);
  } catch (err) {
    console.error('Get production assignments error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/chef/:chefId', authMiddleware.auth, async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      return res.status(400).json({ message: 'Invalid chef ID' });
    }
    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .lean();
    res.status(200).json(tasks);
  } catch (err) {
    console.error('Get chef tasks error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.patch('/:id/status', authMiddleware.auth, authMiddleware.authorize('chef'), async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid task ID' });
    }

    const validStatuses = ['pending', 'in_progress', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid task status' });
    }

    const task = await ProductionAssignment.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const chefProfile = await Chef.findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ message: 'Unauthorized to update this task' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(task.order);
    if (order) {
      const orderItem = order.items.find(i => i.product.toString() === task.product.toString());
      if (orderItem) {
        orderItem.status = status;
        if (status === 'in_progress') orderItem.startedAt = new Date();
        if (status === 'completed') orderItem.completedAt = new Date();
        const allItemsCompleted = order.items.every(i => i.status === 'completed');
        if (allItemsCompleted && order.status !== 'completed') {
          order.status = 'completed';
          order.statusHistory.push({
            status: 'completed',
            changedBy: req.user.id,
            changedAt: new Date(),
          });
          await order.save();
          req.io?.emit('orderStatusUpdated', {
            orderId: task.order,
            status: 'completed',
            user: req.user,
          });
        } else {
          await order.save();
        }
      }
    }

    const populatedTask = await ProductionAssignment.findById(id)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    req.io?.emit('taskStatusUpdated', { taskId: id, status, user: req.user });

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error('Update task status error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;