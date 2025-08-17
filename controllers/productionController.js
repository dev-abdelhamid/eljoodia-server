const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');

const createTask = async (req, res) => {
  console.log('createTask function called');
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1) {
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، والكمية الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order);
    if (!orderDoc) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    let orderItem;
    if (itemId && mongoose.isValidObjectId(itemId)) {
      orderItem = orderDoc.items.id(itemId);
      if (!orderItem || orderItem.product.toString() !== product) {
        return res.status(400).json({ success: false, message: 'العنصر أو المنتج غير موجود في الطلب' });
      }
    } else {
      orderItem = orderDoc.items.find(i => i.product.toString() === product);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: 'المنتج غير موجود في الطلب' });
      }
      itemId = orderItem._id; // تعيين itemId تلقائيًا إذا لم يتم تمريره
    }

    console.log('Creating task:', { orderId: order, itemId: orderItem._id, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
      itemId,
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

    io.to(`chef-${chef}`).emit('taskAssigned', populatedAssignment);
    io.to('admin').emit('taskAssigned', populatedAssignment);
    io.to('production').emit('taskAssigned', populatedAssignment);
    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error('خطأ في إنشاء المهمة:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ createdAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product);
    if (validTasks.length === 0 && tasks.length > 0) {
      console.warn('تم تصفية مهام غير صالحة:', tasks.filter(task => !task.order || !task.product));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error('خطأ في جلب المهام:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
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

    const validTasks = tasks.filter(task => task.order && task.product);
    if (validTasks.length === 0 && tasks.length > 0) {
      console.warn('تم تصفية مهام غير صالحة:', tasks.filter(task => !task.order || !task.product));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error('خطأ في جلب مهام الشيف:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(id).populate('order');
    if (!task) {
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    console.log('Updating task:', { taskId: id, itemId: task.itemId, status });

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(task.order._id).populate('items');
    if (!order) {
      console.error('Order not found:', { orderId: task.order._id });
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error('Order item not found:', { orderId: task.order._id, itemId: task.itemId });
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    await order.save();

    const allAssignments = await ProductionAssignment.find({ order: task.order._id }).lean();
    const allOrderItems = order.items;
    const allTasksCompleted = allAssignments.every((a) => a.status === 'completed');
    const allOrderItemsCompleted = allOrderItems.every((i) => i.status === 'completed');

    console.log('Completion check:', {
      orderId: task.order._id,
      allTasksCompleted,
      allOrderItemsCompleted,
      assignmentsCount: allAssignments.length,
      itemsCount: allOrderItems.length,
    });

    if (allTasksCompleted && allOrderItemsCompleted) {
      if (order.status !== 'completed') {
        order.status = 'completed';
        order.statusHistory.push({ status: 'completed', changedBy: req.user.id, changedAt: new Date() });
        await order.save();

        const populatedOrder = await Order.findById(task.order._id)
          .populate('branch', 'name')
          .populate({
            path: 'items.product',
            select: 'name price unit department',
            populate: { path: 'department', select: 'name code' },
          })
          .populate('items.assignedTo', 'username')
          .lean();

        io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: task.order._id, status: 'completed', user: req.user });
        io.to('admin').emit('orderStatusUpdated', { orderId: task.order._id, status: 'completed', user: req.user });
        io.to('production').emit('orderStatusUpdated', { orderId: task.order._id, status: 'completed', user: req.user });
        console.log(`Order ${task.order._id} updated to completed`);
      }
    } else if (order.status === 'completed' && !allTasksCompleted) {
      // إذا تغيرت حالة الطلب لـ "in_production" مرة أخرى
      order.status = 'in_production';
      order.statusHistory.push({ status: 'in_production', changedBy: req.user.id, changedAt: new Date() });
      await order.save();
      io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: task.order._id, status: 'in_production', user: req.user });
      io.to('admin').emit('orderStatusUpdated', { orderId: task.order._id, status: 'in_production', user: req.user });
      io.to('production').emit('orderStatusUpdated', { orderId: task.order._id, status: 'in_production', user: req.user });
    }

    const populatedTask = await ProductionAssignment.findById(id)
      .populate('order', 'orderNumber status')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', { taskId: id, status });
    io.to(order.branch.toString()).emit('taskStatusUpdated', { taskId: id, status });
    io.to('admin').emit('taskStatusUpdated', { taskId: id, status });
    io.to('production').emit('taskStatusUpdated', { taskId: id, status });
    if (status === 'completed') {
      io.to(`chef-${task.chef}`).emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
      io.to(order.branch.toString()).emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
      io.to('admin').emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
      io.to('production').emit('taskCompleted', { orderId: task.order._id, orderNumber: populatedTask.order.orderNumber });
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error('خطأ في تحديث حالة المهمة:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus };