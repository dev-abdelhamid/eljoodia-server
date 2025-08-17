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
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    }

    const task = await ProductionAssignment.findById(id).populate('order');
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(task.order._id).populate('items');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) return res.status(400).json({ success: false, message: 'Order item not found' });

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    await order.save();

    // تحقق من اكتمال جميع العناصر
    const allAssignments = await ProductionAssignment.find({ order: task.order._id });
    const allTasksCompleted = allAssignments.every((a) => a.status === 'completed');
    const allOrderItemsCompleted = order.items.every((i) => i.status === 'completed');

    if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({ status: 'completed', changedBy: req.user.id, changedAt: new Date() });
      await order.save();

      // إرسال إشعار لجميع الغرف
      io.to(`branch-${order.branch}`).emit('orderStatusUpdated', { orderId: order._id, status: 'completed', user: req.user });
      io.to('admin').emit('orderStatusUpdated', { orderId: order._id, status: 'completed', user: req.user });
      io.to('production').emit('orderStatusUpdated', { orderId: order._id, status: 'completed', user: req.user });
      console.log(`Order ${order._id} marked as completed and notified`);
    }

    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', { taskId: id, status, orderId: order._id });
    io.to(`branch-${order.branch}`).emit('taskStatusUpdated', { taskId: id, status, orderId: order._id });
    io.to('admin').emit('taskStatusUpdated', { taskId: id, status, orderId: order._id });
    io.to('production').emit('taskStatusUpdated', { taskId: id, status, orderId: order._id });

    res.status(200).json({ success: true, task });
  } catch (err) {
    console.error('Error updating task status:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus };