// routes/productionAssignments.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Chef = require('../models/Chef');
const mongoose = require('mongoose');

router.post('/', authMiddleware.auth, authMiddleware.authorize('admin', 'production'), async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1) {
      console.error(`Invalid data in creating assignment at ${new Date().toISOString()}:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ message: 'معرف الطلب، المنتج، الشيف، والكمية الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order);
    if (!orderDoc) {
      console.error(`Order not found at ${new Date().toISOString()}:`, order);
      return res.status(404).json({ message: 'الطلب غير موجود' });
    }

    let orderItem;
    if (itemId && mongoose.isValidObjectId(itemId)) {
      orderItem = orderDoc.items.id(itemId);
      if (!orderItem || orderItem.product.toString() !== product) {
        console.error(`Item or product not found in order at ${new Date().toISOString()}:`, { orderId: order, itemId, product });
        return res.status(400).json({ message: 'العنصر أو المنتج غير موجود في الطلب' });
      }
    } else {
      orderItem = orderDoc.items.find((i) => i.product.toString() === product);
      if (!orderItem) {
        console.error(`Product not found in order at ${new Date().toISOString()}:`, { orderId: order, product });
        return res.status(400).json({ message: 'المنتج غير موجود في الطلب' });
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

    const io = req.app.get('io');
    io.to(`chef-${chef}`).emit('taskAssigned', populatedAssignment);
    io.to('admin').emit('taskAssigned', populatedAssignment);
    io.to('production').emit('taskAssigned', populatedAssignment);
    io.to(`branch-${orderDoc.branch}`).emit('taskAssigned', populatedAssignment);

    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error(`Error creating production assignment at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const assignments = await ProductionAssignment.find()
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(assignments);
  } catch (err) {
    console.error(`Error fetching production assignments at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/chef/:chefId', authMiddleware.auth, async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`Invalid chef ID at ${new Date().toISOString()}:`, chefId);
      return res.status(400).json({ message: 'معرف الشيف غير صالح' });
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
    console.error(`Error fetching chef tasks at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.patch('/:id/status', authMiddleware.auth, authMiddleware.authorize('chef'), async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      console.error(`Invalid task ID at ${new Date().toISOString()}:`, id);
      return res.status(400).json({ message: 'معرف المهمة غير صالح' });
    }

    const validStatuses = ['pending', 'in_progress', 'completed'];
    if (!validStatuses.includes(status)) {
      console.error(`Invalid status at ${new Date().toISOString()}:`, status);
      return res.status(400).json({ message: 'حالة المهمة غير صالحة' });
    }

    const task = await ProductionAssignment.findById(id).populate('order');
    if (!task) {
      console.error(`Task not found at ${new Date().toISOString()}:`, id);
      return res.status(404).json({ message: 'المهمة غير موجودة' });
    }

    const chefProfile = await Chef.findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`Unauthorized to update task at ${new Date().toISOString()}:`, { taskId: id, userId: req.user.id });
      return res.status(403).json({ message: 'غير مخول لتحديث هذه المهمة' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(task.order._id);
    if (!order) {
      console.error(`Order not found at ${new Date().toISOString()}:`, task.order._id);
      return res.status(404).json({ message: 'الطلب غير موجود' });
    }

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`Item not found in order at ${new Date().toISOString()}:`, { orderId: task.order._id, itemId: task.itemId });
      return res.status(400).json({ message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    const allItemsCompleted = order.items.every((i) => i.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({ status: 'completed', changedBy: req.user.id, changedAt: new Date() });
      await order.save();
      const io = req.app.get('io');
      io.to('admin').emit('orderStatusUpdated', { orderId: task.order._id, status: 'completed' });
      io.to('production').emit('orderStatusUpdated', { orderId: task.order._id, status: 'completed' });
      io.to(`branch-${order.branch}`).emit('orderStatusUpdated', { orderId: task.order._id, status: 'completed' });
    }
    await order.save();

    const populatedTask = await ProductionAssignment.findById(id)
      .populate('order', 'orderNumber status')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    const io = req.app.get('io');
    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', { taskId: id, status });
    io.to('admin').emit('taskStatusUpdated', { taskId: id, status });
    io.to('production').emit('taskStatusUpdated', { taskId: id, status });
    io.to(`branch-${order.branch}`).emit('taskStatusUpdated', { taskId: id, status });
    if (status === 'completed') {
      io.to(`chef-${task.chef}`).emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
      io.to('admin').emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
      io.to('production').emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
      io.to(`branch-${order.branch}`).emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`Error updating task status at ${new Date().toISOString()}:`, err);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;