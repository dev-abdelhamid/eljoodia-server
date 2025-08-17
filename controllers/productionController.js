const express = require('express');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Chef = require('../models/Chef');
const mongoose = require('mongoose');

const createTask = async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 || !mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ message: 'Order, product, chef, quantity, and itemId are required and must be valid' });
    }

    const newAssignment = new ProductionAssignment({ order, product, chef, quantity, itemId });
    await newAssignment.save();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    const io = req.app.get('io');
    io.to(`chef-${chef}`).emit('taskAssigned', populatedAssignment);

    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error(`Error creating production assignment at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getTasks = async (req, res) => {
  try {
    const assignments = await ProductionAssignment.find()
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ docs: assignments, totalDocs: assignments.length, page: 1, limit: assignments.length });
  } catch (err) {
    console.error(`Error fetching production assignments at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
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
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ docs: tasks, totalDocs: tasks.length, page: 1, limit: tasks.length });
  } catch (err) {
    console.error(`Error fetching chef tasks at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { orderId, taskId } = req.params;

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      return res.status(400).json({ message: 'Invalid order ID or task ID' });
    }

    const validStatuses = ['pending', 'in_progress', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid task status' });
    }

    const task = await ProductionAssignment.findOne({ order: orderId, itemId: taskId });
    if (!task) {
      return res.status(404).json({ message: `Task with itemId ${taskId} for order ${orderId} not found` });
    }

    const chefProfile = await Chef.findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ message: 'Unauthorized to update this task' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(orderId);
    if (order) {
      const orderItem = order.items.find((i) => i._id.toString() === taskId);
      if (orderItem) {
        orderItem.status = status;
        if (status === 'in_progress') orderItem.startedAt = new Date();
        if (status === 'completed') orderItem.completedAt = new Date();
        const allItemsCompleted = order.items.every((i) => i.status === 'completed');
        if (allItemsCompleted && order.status !== 'completed') {
          order.status = 'completed';
          order.statusHistory.push({ status: 'completed', changedBy: req.user.id, changedAt: new Date() });
          await order.save();
          req.app.get('io').emit('orderStatusUpdated', { orderId: task.order, status: 'completed', user: req.user });
        }
        await order.save();
      }
    }

    const populatedTask = await ProductionAssignment.findById(task._id)
      .populate('order', 'orderNumber')
      .populate({ path: 'product', select: 'name department', populate: { path: 'department', select: 'name code' } })
      .populate('chef', 'user')
      .lean();

    req.app.get('io').emit('taskStatusUpdated', { taskId, status, orderId });
    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`Error updating task status at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus };