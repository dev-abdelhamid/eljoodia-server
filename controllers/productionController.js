const mongoose = require('mongoose');
const { isValidObjectId } = require('mongoose');
const Order = mongoose.model('Order');
const ProductionAssignment = mongoose.model('ProductionAssignment');
const User = mongoose.model('User');
const { createNotification } = require('./notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  try {
    io.to(rooms).emit(eventName, eventData);
    console.log(`[${new Date().toISOString()}] Emitted ${eventName} to rooms: ${rooms.join(', ')}`, eventData);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error emitting ${eventName}: ${err.message}`);
  }
};

const notifyUsers = async (io, users, type, message, data) => {
  try {
    for (const user of users) {
      await createNotification({
        userId: user._id,
        type,
        message,
        data
      }, io);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error notifying users: ${err.message}`);
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!isValidObjectId(order) || !isValidObjectId(product) ||
        !isValidObjectId(chef) || !quantity || quantity < 1 ||
        !isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: 'Invalid order, product, chef, quantity, or itemId' });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ success: false, message: 'Order must be approved before assigning tasks' });
    }

    const productDoc = await mongoose.model('Product').findById(product).populate('department').session(session);
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef:`, { chefId: chef, chefRole: chefDoc?.role });
      return res.status(400).json({ success: false, message: 'Invalid chef' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ success: false, message: `Item ${itemId} not found in order or does not match product` });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });

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
      sound: '/notification.mp3',
      vibrate: [400, 100, 400]
    };
    await emitSocketEvent(io, [`chef-${chefProfile._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `You have been assigned to produce ${productDoc.name} for order ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch }
    );

    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const { orderId, chefId, status, departmentId } = req.query;
    const query = {};
    if (orderId && isValidObjectId(orderId)) query.order = orderId;
    if (chefId && isValidObjectId(chefId)) query.chef = chefId;
    if (status) query.status = status;
    if (departmentId && isValidObjectId(departmentId)) {
      const products = await mongoose.model('Product').find({ department: departmentId }).select('_id').lean();
      query.product = { $in: products.map(p => p._id) };
    }

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
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
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid order ID or task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Missing itemId in task' });
    }
    if (task.order._id.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match order ${orderId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Task does not match order' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Unauthorized to update this task' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Task already completed' });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}`);

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Item ${task.itemId} not found in order` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    console.log(`[${new Date().toISOString()}] Updated order item ${task.itemId} status to ${status}`);

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date()
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'in_production'`);
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_status_updated',
        `Order ${order.orderNumber} production started`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        sound: '/status-updated.mp3',
        vibrate: [200, 100, 200]
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', orderStatusUpdatedEvent);
    }

    order.markModified('items');
    await order.save({ session });

    // Check if all items are completed
    const allItemsCompleted = order.items.every(i => i.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed' && order.status !== 'in_transit' && order.status !== 'delivered') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date()
      });
      console.log(`[${new Date().toISOString()}] Order ${orderId} marked as completed after task update`);
      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `Order ${order.orderNumber} completed for branch ${branch?.name || 'Unknown'}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName: branch?.name || 'Unknown' }
      );
      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300]
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', orderCompletedEvent);
      await order.save({ session });
    }

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

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      itemId: task.itemId,
      sound: '/notification.mp3',
      vibrate: [200, 100, 200]
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
        sound: '/notification.mp3',
        vibrate: [200, 100, 200]
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskCompleted', taskCompletedEvent);
      await notifyUsers(io, [{ _id: task.chef._id }], 'task_completed',
        `Task completed for order ${task.order.orderNumber}`,
        { taskId, orderId, orderNumber: task.order.orderNumber, branchId: order.branch }
      );
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    console.log(`[${new Date().toISOString()}] Starting syncOrderTasks for order ${orderId}`);
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found for sync: ${orderId}`);
      throw new Error('Order not found');
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    const taskItemIds = tasks.map(t => t.itemId?.toString()).filter(Boolean);
    const missingItems = order.items.filter(item => !taskItemIds.includes(item._id?.toString()) && item._id);

    console.log(`[${new Date().toISOString()}] syncOrderTasks: Checking order ${orderId}, found ${missingItems.length} missing items`);

    if (missingItems.length > 0) {
      console.warn(`[${new Date().toISOString()}] Missing assignments for order ${orderId}:`,
        missingItems.map(i => ({ id: i._id, product: i.product?.name })));

      for (const item of missingItems) {
        if (!item._id) {
          console.error(`[${new Date().toISOString()}] Invalid item in order ${orderId}: No _id found`, item);
          continue;
        }
        const product = await mongoose.model('Product').findById(item.product).lean();
        if (!product) {
          console.warn(`[${new Date().toISOString()}] Product not found: ${item.product}`);
          continue;
        }
        await emitSocketEvent(io, ['production', 'admin', `branch-${order.branch}`], 'missingAssignments', {
          orderId,
          itemId: item._id,
          productId: product._id,
          productName: product.name,
          sound: '/notification.mp3',
          vibrate: [200, 100, 200]
        });
      }
    }

    let hasIncompleteItems = false;
    for (const task of tasks) {
      const orderItem = order.items.id(task.itemId);
      if (orderItem) {
        if (task.status !== orderItem.status) {
          console.log(`[${new Date().toISOString()}] Syncing order item ${task.itemId} status from ${orderItem.status} to ${task.status}`);
          orderItem.status = task.status;
          if (task.status === 'in_progress') orderItem.startedAt = task.startedAt || new Date();
          if (task.status === 'completed') orderItem.completedAt = task.completedAt || new Date();
        }
        if (task.status !== 'completed') hasIncompleteItems = true;
      } else {
        console.error(`[${new Date().toISOString()}] Order item ${task.itemId} not found in order ${orderId}`);
      }
    }

    // Check for items without tasks
    for (const item of order.items) {
      if (!taskItemIds.includes(item._id.toString()) && item.status !== 'completed') {
        console.warn(`[${new Date().toISOString()}] Item ${item._id} in order ${orderId} has no task and is not completed`);
        hasIncompleteItems = true;
      }
    }

    order.markModified('items');
    await order.save({ session });

    const allTasksCompleted = tasks.every(t => t.status === 'completed');
    const allOrderItemsCompleted = order.items.every(i => i.status === 'completed');

    console.log(`[${new Date().toISOString()}] syncOrderTasks: Order ${orderId} status check:`, {
      allTasksCompleted,
      allOrderItemsCompleted,
      taskCount: tasks.length,
      itemCount: order.items.length,
      incompleteTasks: tasks.filter(t => t.status !== 'completed').map(t => ({ id: t._id, status: t.status, itemId: t.itemId })),
      incompleteItems: order.items.filter(i => i.status !== 'completed').map(i => ({ id: i._id, status: i.status }))
    });

    if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed' && order.status !== 'in_transit' && order.status !== 'delivered') {
      console.log(`[${new Date().toISOString()}] Completing order ${orderId} from syncOrderTasks: all tasks and items completed`);
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date(),
      });
      console.log(`[${new Date().toISOString()}] Added statusHistory entry for order ${orderId}:`, {
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date().toISOString()
      });

      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `Order ${order.orderNumber} completed for branch ${branch?.name || 'Unknown'}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName: branch?.name || 'Unknown' }
      );

      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300]
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', orderCompletedEvent);
    } else if (!allTasksCompleted || !allOrderItemsCompleted) {
      console.warn(`[${new Date().toISOString()}] Order ${orderId} not completed in syncOrderTasks:`, {
        allTasksCompleted,
        allOrderItemsCompleted,
        incompleteTasks: tasks.filter(t => t.status !== 'completed').map(t => ({ id: t._id, status: t.status, itemId: t.itemId })),
        incompleteItems: order.items.filter(i => i.status !== 'completed').map(i => ({ id: i._id, status: i.status }))
      });
    }

    await order.save({ session });
    console.log(`[${new Date().toISOString()}] Saved updated order ${orderId}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in syncOrderTasks for order ${orderId}:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };