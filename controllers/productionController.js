const mongoose = require('mongoose');
const Order = require('../models/Order');
const ProductionAssignment = require('../models/ProductionAssignment');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');
const { emitSocketEvent } = require('../utils/socketUtils');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { order, product, chef, quantity, itemId } = req.body;

    if (!isValidObjectId(order) || !isValidObjectId(product) || !isValidObjectId(chef) || !isValidObjectId(itemId)) {
      console.error(`[${new Date().toISOString()}] Invalid IDs in createTask:`, { order, product, chef, itemId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Invalid order, product, chef, or item ID' });
    }

    if (quantity < 1) {
      console.error(`[${new Date().toISOString()}] Invalid quantity in createTask: ${quantity}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Quantity must be at least 1' });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      console.error(`[${new Date().toISOString()}] Order not found in createTask: ${order}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const orderItem = orderDoc.items.find(item => item._id.toString() === itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Item not found in createTask: ${itemId}, Order: ${order}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order item not found' });
    }

    const chefDoc = await User.findOne({ _id: chef, role: 'chef' }).session(session);
    if (!chefDoc) {
      console.error(`[${new Date().toISOString()}] Chef not found in createTask: ${chef}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Chef not found' });
    }

    const task = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
      itemId,
      status: 'pending',
      createdBy: req.user.id,
    });

    await task.save({ session });

    orderItem.assignedTo = chef;
    orderItem.status = 'in_production';
    await orderDoc.save({ session });

    const io = req.app.get('io');
    await createNotification(
      chef,
      'new_production_assigned_to_chef',
      `New task assigned for order ${orderDoc.orderNumber}`,
      {
        orderId: order,
        orderNumber: orderDoc.orderNumber,
        itemId,
        path: '/production-tasks',
      },
      io
    );

    await emitSocketEvent(io, [`chef-${chef}`], 'new_production_assigned_to_chef', {
      _id: task._id,
      type: 'info',
      event: 'new_production_assigned_to_chef',
      message: `New task assigned for order ${orderDoc.orderNumber}`,
      data: {
        orderId: order,
        orderNumber: orderDoc.orderNumber,
        itemId,
        path: '/production-tasks',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, data: task });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const { status, order, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (order && isValidObjectId(order)) query.order = order;
    if (req.user.role === 'branch') {
      query.order = { $in: await Order.find({ branch: req.user.branchId }).distinct('_id') };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    console.log(`[${new Date().toISOString()}] Fetching tasks with query:`, {
      query,
      page,
      limit,
      userId: req.user.id,
      role: req.user.role,
    });

    const [tasks, totalTasks] = await Promise.all([
      ProductionAssignment.find(query)
        .populate('order', 'orderNumber branch')
        .populate('product', 'name')
        .populate('chef', 'username')
        .populate('createdBy', 'username')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      ProductionAssignment.countDocuments(query),
    ]);

    console.log(`[${new Date().toISOString()}] Found ${tasks.length} tasks of ${totalTasks}`);

    res.status(200).json({
      success: true,
      tasks: tasks.map(task => ({
        ...task,
        createdAt: new Date(task.createdAt).toISOString(),
      })),
      pagination: {
        total: totalTasks,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalTasks / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    const { status, page = 1, limit = 10 } = req.query;

    if (!isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chef ID in getChefTasks: ${chefId}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid chef ID' });
    }

    if (req.user.role === 'chef' && chefId !== req.user.id) {
      console.error(`[${new Date().toISOString()}] Unauthorized chef access in getChefTasks:`, {
        requestedChef: chefId,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized to access this chef’s tasks' });
    }

    const query = { chef: chefId };
    if (status) query.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    console.log(`[${new Date().toISOString()}] Fetching chef tasks with query:`, {
      query,
      page,
      limit,
      userId: req.user.id,
    });

    const [tasks, totalTasks] = await Promise.all([
      ProductionAssignment.find(query)
        .populate('order', 'orderNumber branch')
        .populate('product', 'name')
        .populate('chef', 'username')
        .populate('createdBy', 'username')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      ProductionAssignment.countDocuments(query),
    ]);

    console.log(`[${new Date().toISOString()}] Found ${tasks.length} chef tasks of ${totalTasks}`);

    res.status(200).json({
      success: true,
      tasks: tasks.map(task => ({
        ...task,
        createdAt: new Date(task.createdAt).toISOString(),
      })),
      pagination: {
        total: totalTasks,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalTasks / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { orderId, taskId } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid IDs in updateTaskStatus:`, { orderId, taskId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'Invalid order or task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).session(session);
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found in updateTaskStatus: ${taskId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    if (task.chef.toString() !== req.user.id) {
      console.error(`[${new Date().toISOString()}] Unauthorized task access in updateTaskStatus:`, {
        taskChef: task.chef,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'Unauthorized to update this task' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid task status in updateTaskStatus: ${status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'Invalid task status' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();

    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in updateTaskStatus: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const orderItem = order.items.find(item => item._id.toString() === task.itemId);
    if (orderItem) {
      orderItem.status = status;
      if (status === 'completed') {
        orderItem.completedAt = new Date();
      }
      await order.save({ session });
    }

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      role: { $in: ['admin', 'production'] },
    }).select('_id role').lean();

    const message = `Task for order ${order.orderNumber} updated to ${status}`;
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'task_assigned',
        message,
        {
          orderId,
          orderNumber: order.orderNumber,
          taskId,
          path: '/production-tasks',
        },
        io
      );
    }

    await emitSocketEvent(io, ['admin', 'production'], 'task_assigned', {
      _id: taskId,
      type: status === 'completed' ? 'success' : 'info',
      event: 'task_assigned',
      message,
      data: {
        orderId,
        orderNumber: order.orderNumber,
        taskId,
        path: '/production-tasks',
      },
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, data: task });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
};