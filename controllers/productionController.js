const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const User = require('../models/User');
const { Server } = require('socket.io');

const io = new Server({
  cors: {
    origin: ['http://localhost:3000', 'https://eljoodia-production.up.railway.app'],
    methods: ['GET', 'POST'],
  },
});

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف المهمة غير صالح' });
    }

    // جلب المهمة مع تفريغ البيانات (populate) للـ order
    const task = await ProductionAssignment.findById(id).populate('order');
    if (!task) {
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }

    // التحقق من صلاحية الشيف
    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    // التحقق من وجود itemId
    if (!task.itemId || !mongoose.isValidObjectId(task.itemId)) {
      return res.status(400).json({ success: false, message: 'معرف العنصر (itemId) غير صالح أو مفقود' });
    }

    console.log('Updating task:', { taskId: id, itemId: task.itemId, status });

    // تحديث حالة المهمة
    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    // تحديث حالة العنصر في الطلب
    const order = await Order.findById(task.order._id);
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

    // تحقق من اكتمال جميع العناصر
    const allAssignments = await ProductionAssignment.find({ order: task.order._id }).lean();
    const allOrderItems = order.items;
    const allTasksCompleted = allAssignments.every(a => a.status === 'completed');
    const allOrderItemsCompleted = allOrderItems.every(i => i.status === 'completed');

    console.log('Completion check:', {
      orderId: task.order._id,
      allTasksCompleted,
      allOrderItemsCompleted,
      assignmentsCount: allAssignments.length,
      itemsCount: allOrderItems.length,
    });

    if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
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

module.exports = { updateTaskStatus };