const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Branch = mongoose.model('../models/Branch.js');
const { createNotification } = require('../utils/notifications');

// Helper to emit socket events with logging
const emitSocketEvent = (io, rooms, eventName, eventData) => {
  rooms.forEach(room => io.to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, eventData);
};

// Helper to notify users with logging
const notifyUsers = async (io, users, type, message, data) => {
  for (const user of users) {
    await createNotification(user._id, type, message, data, io);
  }
};

// Create a new production task
const createTask = async (req, res) => {
  try {
    const { order: orderId, product: productId, chef: chefId, quantity, itemId } = req.body;
    const io = req.app.get('io');

    // Validate IDs and quantity
    if (![orderId, productId, chefId, itemId].every(mongoose.isValidObjectId) || quantity < 1) {
      return res.status(400).json({ success: false, message: 'معرفات غير صالحة أو كمية غير صالحة' });
    }

    // Fetch order, ensure approved
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    if (order.status !== 'approved') return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب' });

    // Fetch product with department
    const product = await Product.findById(productId).populate('department');
    if (!product) return res.status(404).json({ success: false, message: 'المنتج غير موجود' });

    // Fetch chef profile and user, validate role and department match
    const chefProfile = await mongoose.model('Chef').findOne({ user: chefId });
    const chefUser = await User.findById(chefId).populate('department');
    if (!chefProfile || !chefUser || chefUser.role !== 'chef' || chefUser.department._id.toString() !== product.department._id.toString()) {
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع القسم' });
    }

    // Validate order item
    const orderItem = order.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== productId) {
      return res.status(400).json({ success: false, message: 'العنصر غير موجود أو المنتج غير متطابق' });
    }

    console.log(`[${new Date().toISOString()}] Creating task for order ${orderId}, item ${itemId}`);

    // Create assignment
    const assignment = new ProductionAssignment({
      order: orderId,
      product: productId,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending',
    });
    await assignment.save();

    // Update order item
    orderItem.status = 'assigned';
    orderItem.assignedTo = chefId;
    orderItem.department = product.department._id;
    order.markModified('items');
    await order.save();

    // Populate for response and events
    const populatedAssignment = await ProductionAssignment.findById(assignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    const branch = await Branch.findById(order.branch).select('name').lean();
    const branchName = branch?.name || 'Unknown';

    const eventData = {
      ...populatedAssignment,
      branchId: order.branch,
      branchName,
      itemId,
    };

    emitSocketEvent(io, [`chef-${chefId}`, 'admin', 'production', `branch-${order.branch}`], 'taskAssigned', eventData);
    notifyUsers(io, [{ _id: chefId }], 'task_assigned',
      `تم تعيينك لإنتاج ${product.name} للطلب ${order.orderNumber}`,
      { taskId: assignment._id, orderId, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get all production tasks
const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered ${tasks.length - validTasks.length} invalid tasks`);
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get tasks for a specific chef
const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered ${tasks.length - validTasks.length} invalid tasks for chef ${chefId}`);
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update task status
const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order');
    if (!task) return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    if (!task.itemId) return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
    if (task.order._id.toString() !== orderId) return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (task.status === 'completed' && status === 'completed') {
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} to ${status}`);

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    order.markModified('items');
    await order.save();

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({ status: 'in_production', changedBy: req.user.id, changedAt: new Date() });
      order.markModified('items');
      await order.save();

      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      notifyUsers(io, usersToNotify, 'order_status_updated', `بدأ إنتاج الطلب ${order.orderNumber}`, {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
      });

      const branch = await Branch.findById(order.branch).select('name').lean();
      const eventData = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
      };
      emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', eventData);
    }

    await syncOrderTasks(orderId, io);

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    const branch = await Branch.findById(order.branch).select('name').lean();
    const branchName = branch?.name || 'Unknown';

    const updateEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName,
      itemId: task.itemId,
    };
    emitSocketEvent(io, [`chef-${task.chef.user}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', updateEvent);

    if (status === 'completed') {
      const completeEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName,
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef.user },
        itemId: task.itemId,
      };
      emitSocketEvent(io, [`chef-${task.chef.user}`, `branch-${order.branch}`, 'admin', 'production'], 'taskCompleted', completeEvent);
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Sync order tasks with assignments
const syncOrderTasks = async (orderId, io) => {
  try {
    const order = await Order.findById(orderId).populate('items.product').lean();
    if (!order) {
      console.warn(`[${new Date().toISOString()}] Order ${orderId} not found for sync`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    const taskItemIds = tasks.map(t => t.itemId?.toString()).filter(id => id);
    const missingItems = order.items.filter(item => !taskItemIds.includes(item._id?.toString()));

    console.log(`[${new Date().toISOString()}] Syncing order ${orderId}: ${missingItems.length} missing assignments`);

    if (missingItems.length > 0) {
      console.warn(`[${new Date().toISOString()}] Missing assignments for order ${orderId}: ${missingItems.map(i => i._id).join(', ')}`);
      for (const item of missingItems) {
        if (!item._id || !item.product) continue;
        const product = await Product.findById(item.product);
        if (!product) continue;
        emitSocketEvent(io, ['production', 'admin', `branch-${order.branch}`], 'missingAssignments', {
          orderId,
          itemId: item._id,
          productId: product._id,
          productName: product.name,
        });
      }
    }

    const updatedOrder = await Order.findById(orderId);
    let hasUpdates = false;
    for (const task of tasks) {
      const orderItem = updatedOrder.items.id(task.itemId);
      if (orderItem && orderItem.status !== task.status) {
        orderItem.status = task.status;
        if (task.status === 'in_progress') orderItem.startedAt = task.startedAt || new Date();
        if (task.status === 'completed') orderItem.completedAt = task.completedAt || new Date();
        console.log(`[${new Date().toISOString()}] Synced item ${task.itemId} to ${task.status}`);
        hasUpdates = true;
      }
    }

    if (hasUpdates) updatedOrder.markModified('items');
    await updatedOrder.save();

    const allTasks = await ProductionAssignment.find({ order: orderId }).lean();
    const allTasksCompleted = allTasks.every(t => t.status === 'completed');
    const allItemsCompleted = updatedOrder.items.every(i => i.status === 'completed');

    console.log(`[${new Date().toISOString()}] Sync check for ${orderId}: tasksCompleted=${allTasksCompleted}, itemsCompleted=${allItemsCompleted}`);

    if (allTasksCompleted && allItemsCompleted && updatedOrder.status !== 'completed') {
      console.log(`[${new Date().toISOString()}] Completing order ${orderId}`);
      updatedOrder.status = 'completed';
      updatedOrder.statusHistory.push({ status: 'completed', changedBy: 'system', changedAt: new Date() });
      await updatedOrder.save();

      const branch = await Branch.findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      notifyUsers(io, usersToNotify, 'order_completed', `تم اكتمال الطلب ${order.orderNumber} لفرع ${branch?.name || 'Unknown'}`, {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
      });

      const eventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
      };
      emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', eventData);
      emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', {
        ...eventData,
        status: 'completed',
        user: { id: 'system' },
      });
    } else if (!allTasksCompleted || !allItemsCompleted) {
      console.warn(`[${new Date().toISOString()}] Order ${orderId} not completed`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Sync error for order ${orderId}:`, err);
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };