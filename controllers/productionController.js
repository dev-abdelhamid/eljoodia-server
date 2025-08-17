const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('./orderController');

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، والكمية الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order)
      .populate('branch')
      .populate('items.product')
      .session(session);
    if (!orderDoc) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && orderDoc.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const productDoc = await Product.findById(product)
      .populate('department', 'name code')
      .session(session);
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const chefDoc = await User.findById(chef).populate('department').session(session);
    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile || chefDoc.department?._id.toString() !== productDoc.department._id.toString()) {
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    let orderItem;
    if (itemId && mongoose.isValidObjectId(itemId)) {
      orderItem = orderDoc.items.id(itemId);
      if (!orderItem || orderItem.product.toString() !== product) {
        return res.status(400).json({ success: false, message: `العنصر ${itemId} أو المنتج غير موجود في الطلب` });
      }
    } else {
      orderItem = orderDoc.items.find((i) => i.product.toString() === product);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: 'المنتج غير موجود في الطلب' });
      }
    }

    if (orderItem.quantity < quantity) {
      return res.status(400).json({ success: false, message: 'الكمية المطلوبة تتجاوز كمية العنصر في الطلب' });
    }

    console.log('Creating task:', { orderId: order, itemId: orderItem._id, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId: orderItem._id,
      status: 'pending',
      createdAt: new Date(),
    });

    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;

    if (orderDoc.items.every((item) => item.status === 'assigned' || item.status === 'in_progress' || item.status === 'completed') && orderDoc.status === 'approved') {
      orderDoc.status = 'in_production';
      orderDoc.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }
    await orderDoc.save({ session });

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate({
        path: 'chef',
        select: 'user',
        populate: { path: 'user', select: 'username' },
      })
      .lean();

    await createNotification(
      chef,
      'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order },
      io
    );

    const taskData = {
      _id: newAssignment._id,
      order: { _id: orderDoc._id, orderNumber: orderDoc.orderNumber },
      product: { _id: productDoc._id, name: productDoc.name },
      chef: { _id: chef, username: chefDoc.username || 'Unknown' },
      quantity,
      itemId: orderItem._id,
      status: 'pending',
    };

    io.to(`chef-${chef}`).emit('taskAssigned', taskData);
    io.to(`branch-${orderDoc.branch._id}`).emit('taskAssigned', taskData);
    io.to('production').emit('taskAssigned', taskData);
    io.to('admin').emit('taskAssigned', taskData);

    await session.commitTransaction();
    res.status(201).json({ success: true, data: populatedAssignment });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error creating task at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, department } = req.query;
    const query = {};

    if (status) query.status = status;
    if (department && mongoose.isValidObjectId(department)) {
      query['product.department'] = department;
    }
    if (req.user.role === 'production' && req.user.department) {
      query['product.department'] = req.user.department._id;
    }

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate({
        path: 'chef',
        select: 'user',
        populate: { path: 'user', select: 'username' },
      })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await ProductionAssignment.countDocuments(query);
    const validTasks = tasks.filter((task) => task.order && task.product);

    if (validTasks.length < tasks.length) {
      console.warn(`Filtered out ${tasks.length - validTasks.length} invalid tasks:`, {
        invalidTasks: tasks.filter((task) => !task.order || !task.product),
      });
    }

    res.status(200).json({
      success: true,
      data: validTasks,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error(`Error fetching tasks at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    const { page = 1, limit = 10, status } = req.query;

    if (!mongoose.isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chefId }).session();
    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'الشيف غير موجود' });
    }

    const query = { chef: chefProfile._id };
    if (status) query.status = status;

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate({
        path: 'chef',
        select: 'user',
        populate: { path: 'user', select: 'username' },
      })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await ProductionAssignment.countDocuments(query);
    const validTasks = tasks.filter((task) => task.order && task.product);

    if (validTasks.length < tasks.length) {
      console.warn(`Filtered out ${tasks.length - validTasks.length} invalid tasks for chef ${chefId}:`, {
        invalidTasks: tasks.filter((task) => !task.order || !task.product),
      });
    }

    res.status(200).json({
      success: true,
      data: validTasks,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error(`Error fetching chef tasks at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const syncOrderTasks = async (orderId, io) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(orderId)) {
      console.warn(`Invalid orderId in syncOrderTasks: ${orderId}`);
      return;
    }

    const order = await Order.findById(orderId)
      .populate('items.product')
      .populate('branch')
      .session(session);
    if (!order) {
      console.warn(`Order not found in syncOrderTasks: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    const taskItemIds = tasks.map((t) => t.itemId.toString());
    const missingItems = order.items.filter((item) => !taskItemIds.includes(item._id.toString()));

    const assignments = [];
    for (const item of missingItems) {
      const product = await Product.findById(item.product).session(session);
      if (!product) {
        console.warn(`Product not found for item ${item._id} in order ${orderId}`);
        continue;
      }
      const chef = await mongoose.model('Chef').findOne({ department: product.department }).session(session);
      if (!chef) {
        console.warn(`No chef found for department ${product.department} in order ${orderId}`);
        continue;
      }

      const assignment = new ProductionAssignment({
        order: orderId,
        product: item.product,
        chef: chef._id,
        quantity: item.quantity,
        itemId: item._id,
        status: 'pending',
        createdAt: new Date(),
      });
      assignments.push(assignment);

      item.assignedTo = chef.user;
      item.status = 'assigned';
      item.department = product.department;

      await createNotification(
        chef.user,
        'task_assigned',
        `تم تعيينك لإنتاج ${product.name} في الطلب ${order.orderNumber}`,
        { taskId: assignment._id, orderId },
        io
      );
      io.to(`chef-${chef.user}`).emit('taskAssigned', {
        _id: assignment._id,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: product._id, name: product.name },
        chef: { _id: chef.user, username: chef.user.username || 'Unknown' },
        quantity: item.quantity,
        itemId: item._id,
        status: 'pending',
      });
    }

    if (assignments.length > 0) {
      await ProductionAssignment.insertMany(assignments, { session });
      await order.save({ session });
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error syncing tasks for order ${orderId} at ${new Date().toISOString()}:`, err);
  } finally {
    session.endSession();
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    const task = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .session(session);
    if (!task) {
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (task.order._id.toString() !== orderId) {
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    console.log('Updating task:', { taskId, itemId: task.itemId, status });

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId)
      .populate('items.product')
      .populate('branch')
      .session(session);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`Order item not found: ${task.itemId} for order ${orderId}`);
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
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
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch })
        .select('_id')
        .session(session);
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `بدأ إنتاج الطلب ${order.orderNumber}`,
          { orderId },
          io
        );
      }
      io.to(`branch-${order.branch._id}`).emit('orderStatusUpdated', {
        orderId,
        status: 'in_production',
        statusHistory: order.statusHistory,
      });
      io.to('production').emit('orderStatusUpdated', {
        orderId,
        status: 'in_production',
        statusHistory: order.statusHistory,
      });
      io.to('admin').emit('orderStatusUpdated', {
        orderId,
        status: 'in_production',
        statusHistory: order.statusHistory,
      });
    }

    const allTasks = await ProductionAssignment.find({ order: orderId }).lean();
    const allTasksCompleted = allTasks.every((t) => t.status === 'completed');
    const allOrderItemsCompleted = order.items.every((i) => i.status === 'completed');

    console.log('Completion check:', {
      orderId,
      allTasksCompleted,
      allOrderItemsCompleted,
      assignments: allTasks.map((a) => ({ id: a._id, itemId: a.itemId, status: a.status })),
      items: order.items.map((i) => ({ id: i._id, status: i.status })),
    });

    if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
      console.log(`Order ${orderId} completed: all tasks and items are completed`);
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch })
        .select('_id')
        .session(session);
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_completed',
          `تم اكتمال الطلب ${order.orderNumber}`,
          { orderId },
          io
        );
      }
      io.to(`branch-${order.branch._id}`).emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        statusHistory: order.statusHistory,
      });
      io.to('production').emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        statusHistory: order.statusHistory,
      });
      io.to('admin').emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        statusHistory: order.statusHistory,
      });
      io.to(`branch-${order.branch._id}`).emit('taskCompleted', { orderId, orderNumber: order.orderNumber });
      io.to('production').emit('taskCompleted', { orderId, orderNumber: order.orderNumber });
      io.to('admin').emit('taskCompleted', { orderId, orderNumber: order.orderNumber });
    }

    await order.save({ session });

    await syncOrderTasks(orderId, io);

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate({
        path: 'chef',
        select: 'user',
        populate: { path: 'user', select: 'username' },
      })
      .lean();

    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', { taskId, status });
    io.to(`branch-${order.branch._id}`).emit('taskStatusUpdated', { taskId, status });
    io.to('production').emit('taskStatusUpdated', { taskId, status });
    io.to('admin').emit('taskStatusUpdated', { taskId, status });

    if (status === 'completed') {
      io.to(`chef-${task.chef}`).emit('taskCompleted', { orderId, orderNumber: order.orderNumber });
      io.to(`branch-${order.branch._id}`).emit('taskCompleted', { orderId, orderNumber: order.orderNumber });
      io.to('production').emit('taskCompleted', { orderId, orderNumber: order.orderNumber });
      io.to('admin').emit('taskCompleted', { orderId, orderNumber: order.orderNumber });
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, data: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error updating task status at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };