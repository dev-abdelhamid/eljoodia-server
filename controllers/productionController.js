const mongoose = require('mongoose');
const ProductionAssignment = require('./productionAssignmentModel');
const Order = require('./orderModel');
const Product = require('./productModel');
const User = require('./userModel');
const { createNotification } = require('./notificationService');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach(room => io.to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms, eventData });
};

const notifyUsers = async (io, users, type, message, data) => {
  for (const user of users) {
    await createNotification(user._id, type, message, data, io);
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) ||
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid input data' });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Order must be approved' });
    }

    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid chef or department mismatch' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid order item or product mismatch' });
    }

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending'
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
    };
    await emitSocketEvent(io, [`chef-${chefProfile._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `Assigned to produce ${productDoc.name} for order ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch }
    );

    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'Invalid chef ID' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid order or task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (task.order._id.toString() !== orderId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Task does not match order' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Unauthorized to update this task' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    if (task.status === 'completed' && status === 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Task already completed' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Order item not found' });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      await notifyUsers(io, await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branch: order.branch }).select('_id').lean(),
        'order_status_updated',
        `Production started for order ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', {
        orderId,
        status: 'in_production',
        orderNumber: order.orderNumber,
        branchId: order.branch,
      });
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .lean();

    if (status === 'completed') {
      await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskCompleted', {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
      });
      await notifyUsers(io, [{ _id: task.chef._id }], 'task_completed',
        `Task completed for order ${task.order.orderNumber}`,
        { taskId, orderId, orderNumber: task.order.orderNumber, branchId: order.branch }
      );
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await emitSocketEvent(io, [
          `branch-${order.branch}`,
          'production',
          'admin',
          `department-${item.product.department?._id}`,
        ], 'itemStatusUpdated', {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: item.product.name,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          sound: '/status-updated.mp3',
          vibrate: [200, 100, 200],
        });
      }
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };