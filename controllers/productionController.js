const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('./orderController'); // استيراد createNotification

const createTask = async (req, res) => {
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

    const productDoc = await Product.findById(product).populate('department');
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const chefDoc = await User.findById(chef).populate('department');
    const chefProfile = await mongoose.model('Chef').findOne({ user: chef });
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile || chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    let orderItem;
    if (itemId && mongoose.isValidObjectId(itemId)) {
      orderItem = orderDoc.items.id(itemId);
      if (!orderItem || orderItem.product.toString() !== product) {
        return res.status(400).json({ success: false, message: `العنصر ${itemId} أو المنتج غير موجود في الطلب` });
      }
    } else {
      orderItem = orderDoc.items.find(i => i.product.toString() === product);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: 'المنتج غير موجود في الطلب' });
      }
    }

    console.log('Creating task:', { orderId: order, itemId: orderItem._id, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId: orderItem._id,
      status: 'pending',
    });

    await newAssignment.save();

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
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
      .populate('order', 'orderNumber _id')
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
      .populate('order', 'orderNumber _id')
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

const syncOrderTasks = async (orderId, io) => {
  const order = await Order.findById(orderId).populate('items.product');
  if (!order) return;

  const tasks = await ProductionAssignment.find({ order: orderId }).lean();
  const taskItemIds = tasks.map(t => t.itemId.toString());
  const missingItems = order.items.filter(item => !taskItemIds.includes(item._id.toString()));

  for (const item of missingItems) {
    const product = await Product.findById(item.product);
    if (!product) continue;
    const chef = await mongoose.model('Chef').findOne({ department: product.department });
    if (chef) {
      const assignment = await ProductionAssignment.create({
        order: orderId,
        product: item.product,
        chef: chef._id,
        quantity: item.quantity,
        itemId: item._id,
        status: 'pending'
      });
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
        status: 'pending'
      });
    }
  }
  await order.save();
};

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order chef');
    if (!task) {
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (task.order._id.toString() !== orderId) {
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    console.log('Updating task:', { taskId, itemId: task.itemId, status });

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(orderId).populate('branch');
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error('Order item not found:', { orderId, itemId: task.itemId });
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    // تحديث حالة الطلب إلى in_production عند بدء الإنتاج
    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      await notifyUsers(order, 'order_status_updated', `بدأ إنتاج الطلب ${order.orderNumber}`, io, ['chef', 'branch', 'admin']);
    }

    await order.save();

    await syncOrderTasks(orderId, io);

    const allAssignments = await ProductionAssignment.find({ order: orderId }).lean();
    const allTasksCompleted = allAssignments.every(a => a.status === 'completed');
    const allOrderItemsCompleted = order.items.every(i => i.status === 'completed');

    console.log('Completion check:', {
      orderId,
      allTasksCompleted,
      allOrderItemsCompleted,
      assignments: allAssignments.map(a => ({ id: a._id, itemId: a.itemId, status: a.status })),
      items: order.items.map(i => ({ id: i._id, status: i.status })),
    });

    if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
      console.log(`Order ${order._id} completed: all tasks and items are completed`);
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      await order.save();

      await notifyUsers(order, 'order_completed', `تم اكتمال الطلب ${order.orderNumber}`, io, ['branch', 'admin', 'production']);
    }

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .lean();

    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', { taskId, status, itemId: task.itemId });
    io.to(`branch-${order.branch}`).emit('taskStatusUpdated', { taskId, status, itemId: task.itemId });
    io.to('admin').emit('taskStatusUpdated', { taskId, status, itemId: task.itemId });
    io.to('production').emit('taskStatusUpdated', { taskId, status, itemId: task.itemId });
    if (status === 'completed') {
      io.to(`chef-${task.chef}`).emit('taskCompleted', { orderId, orderNumber: task.order.orderNumber, itemId: task.itemId });
      io.to(`branch-${order.branch}`).emit('taskCompleted', { orderId, orderNumber: task.order.orderNumber, itemId: task.itemId });
      io.to('admin').emit('taskCompleted', { orderId, orderNumber: task.order.orderNumber, itemId: task.itemId });
      io.to('production').emit('taskCompleted', { orderId, orderNumber: task.order.orderNumber, itemId: task.itemId });
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error('خطأ في تحديث حالة المهمة:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// دالة مساعدة لإرسال الإشعارات
const notifyUsers = async (order, type, message, io, roles) => {
  const usersToNotify = await User.find({ role: { $in: roles }, branchId: order.branch }).select('_id');
  for (const user of usersToNotify) {
    await createNotification(
      user._id,
      type,
      message,
      { orderId: order._id },
      io
    );
  }
  io.to(`branch-${order.branch}`).emit(type === 'order_status_updated' ? 'orderStatusUpdated' : 'orderCompleted', {
    orderId: order._id,
    status: order.status,
    user: { id: usersToNotify[0], username: 'System' }, // يمكن تحسين هذا
  });
  io.to('admin').emit(type === 'order_status_updated' ? 'orderStatusUpdated' : 'orderCompleted', {
    orderId: order._id,
    status: order.status,
    user: { id: usersToNotify[0], username: 'System' },
  });
  io.to('production').emit(type === 'order_status_updated' ? 'orderStatusUpdated' : 'orderCompleted', {
    orderId: order._id,
    status: order.status,
    user: { id: usersToNotify[0], username: 'System' },
  });
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };
module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };