const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Chef = require('../models/Chef');
const Notification = require('../models/Notification');

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

const createTask = async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1) {
      return res.status(400).json({ success: false, message: 'Valid order, product, chef, and quantity are required' });
    }

    const orderDoc = await Order.findById(order);
    if (!orderDoc) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    let orderItem;
    if (itemId && mongoose.isValidObjectId(itemId)) {
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

    const chefProfile = await Chef.findById(chef);
    if (!chefProfile) {
      return res.status(400).json({ success: false, message: 'Chef not found' });
    }

    console.log(`Creating task at ${new Date().toISOString()}:`, { orderId: order, itemId: orderItem._id, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
      itemId: orderItem._id,
      status: 'pending',
      createdAt: new Date(),
    });

    await newAssignment.save();

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderDoc.status = orderDoc.items.every((i) => i.status === 'assigned') ? 'in_production' : orderDoc.status;
    if (orderDoc.isModified('status')) {
      orderDoc.statusHistory.push({ status: orderDoc.status, changedBy: req.user.id, changedAt: new Date() });
    }
    await orderDoc.save();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate({ path: 'chef', populate: { path: 'user', select: 'username' } })
      .lean();

    await createNotification(
      chefProfile.user,
      'task_assigned',
      `New task assigned: produce ${populatedAssignment.product.name} for order ${populatedAssignment.order.orderNumber}`,
      { taskId: newAssignment._id, orderId: order },
      io
    );

    io.to(`chef-${chef}`).emit('taskAssigned', populatedAssignment);
    io.to('admin').emit('taskAssigned', populatedAssignment);
    io.to('production').emit('taskAssigned', populatedAssignment);

    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error(`Error creating task at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getTasks = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { createdAt: -1 },
      populate: [
        { path: 'order', select: 'orderNumber' },
        {
          path: 'product',
          select: 'name department',
          populate: { path: 'department', select: 'name code' },
        },
        { path: 'chef', populate: { path: 'user', select: 'username' } },
      ],
      lean: true,
    };

    const tasks = await ProductionAssignment.paginate({}, options);
    const validTasks = tasks.docs.filter((task) => task.order && task.product);
    if (validTasks.length === 0 && tasks.docs.length > 0) {
      console.warn(`Filtered invalid tasks at ${new Date().toISOString()}:`, tasks.docs.filter((task) => !task.order || !task.product));
    }

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`Error fetching tasks at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'Invalid chef ID' });
    }

    const chefProfile = await Chef.findById(chefId);
    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'Chef not found' });
    }

    const options = {
      page: parseInt(req.query.page || 1, 10),
      limit: parseInt(req.query.limit || 10, 10),
      sort: { createdAt: -1 },
      populate: [
        { path: 'order', select: 'orderNumber' },
        {
          path: 'product',
          select: 'name department',
          populate: { path: 'department', select: 'name code' },
        },
        { path: 'chef', populate: { path: 'user', select: 'username' } },
      ],
      lean: true,
    };

    const tasks = await ProductionAssignment.paginate({ chef: chefId }, options);
    const validTasks = tasks.docs.filter((task) => task.order && task.product);
    if (validTasks.length === 0 && tasks.docs.length > 0) {
      console.warn(`Filtered invalid tasks for chef ${chefId} at ${new Date().toISOString()}:`, tasks.docs.filter((task) => !task.order || !task.product));
    }

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`Error fetching chef tasks at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order');
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const chefProfile = await Chef.findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this task' });
    }

    const validStatuses = ['pending', 'in_progress', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid task status' });
    }

    const validTransitions = {
      pending: ['in_progress'],
      in_progress: ['completed'],
      completed: [],
    };
    if (!validTransitions[task.status].includes(status)) {
      return res.status(400).json({ success: false, message: `Transition from ${task.status} to ${status} is not allowed` });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(task.order._id);
    if (order) {
      const orderItem = order.items.id(task.itemId);
      if (!orderItem) {
        console.error(`Order item not found at ${new Date().toISOString()}:`, { orderId: task.order._id, itemId: task.itemId });
        return res.status(400).json({ success: false, message: `Item ${task.itemId} not found in order` });
      }

      orderItem.status = status;
      if (status === 'in_progress') orderItem.startedAt = new Date();
      if (status === 'completed') orderItem.completedAt = new Date();

      const allAssignments = await ProductionAssignment.find({ order: task.order }).lean();
      const allTasksCompleted = allAssignments.every((a) => a.status === 'completed');
      const allOrderItemsCompleted = order.items.every((i) => i.status === 'completed');

      if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: req.user.id,
          changedAt: new Date(),
        });

        const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: order.branch }).select('_id');
        for (const user of usersToNotify) {
          await createNotification(
            user._id,
            'order_status_updated',
            `Order ${order.orderNumber} completed`,
            { orderId: task.order._id },
            io
          );
        }

        io.to(`branch-${order.branch}`).emit('orderStatusUpdated', {
          orderId: task.order._id,
          status: 'completed',
          user: req.user,
        });
        io.to('admin').emit('orderStatusUpdated', {
          orderId: task.order._id,
          status: 'completed',
          user: req.user,
        });
        io.to('production').emit('orderStatusUpdated', {
          orderId: task.order._id,
          status: 'completed',
          user: req.user,
        });
      }

      await order.save();
    }

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate({ path: 'chef', populate: { path: 'user', select: 'username' } })
      .lean();

    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', { taskId, status });
    io.to(`branch-${order.branch}`).emit('taskStatusUpdated', { taskId, status });
    io.to('admin').emit('taskStatusUpdated', { taskId, status });
    io.to('production').emit('taskStatusUpdated', { taskId, status });

    if (status === 'completed') {
      await createNotification(
        chefProfile.user,
        'task_completed',
        `Task for order ${populatedTask.order.orderNumber} completed`,
        { taskId, orderId: task.order._id },
        io
      );

      io.to(`chef-${task.chef}`).emit('taskCompleted', {
        orderId: task.order._id,
        orderNumber: task.order.orderNumber,
      });
      io.to(`branch-${order.branch}`).emit('taskCompleted', {
        orderId: task.order._id,
        orderNumber: task.order.orderNumber,
      });
      io.to('admin').emit('taskCompleted', {
        orderId: task.order._id,
        orderNumber: task.order.orderNumber,
      });
      io.to('production').emit('taskCompleted', {
        orderId: task.order._id,
        orderNumber: task.order.orderNumber,
      });
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`Error updating task status at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus };