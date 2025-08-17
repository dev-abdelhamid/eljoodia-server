const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('./orderController');

const createTask = async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1) {
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، والكمية الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order).lean();
    if (!orderDoc) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const productDoc = await Product.findById(product).populate('department').lean();
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const chefDoc = await User.findById(chef).populate('department').lean();
    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).lean();
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile || chefDoc.department?._id.toString() !== productDoc.department?._id.toString()) {
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    let orderItem;
    if (itemId && mongoose.isValidObjectId(itemId)) {
      orderItem = orderDoc.items.find((i) => i._id.toString() === itemId);
      if (!orderItem || orderItem.product.toString() !== product) {
        return res.status(400).json({ success: false, message: `العنصر ${itemId} أو المنتج غير موجود في الطلب` });
      }
    } else {
      orderItem = orderDoc.items.find((i) => i.product.toString() === product);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: 'المنتج غير موجود في الطلب' });
      }
    }

    console.log('Creating task:', { orderId: order, itemId: orderItem._id, product, chef, quantity });

    const updatedOrder = await Order.findById(order);
    const targetItem = updatedOrder.items.id(orderItem._id);
    if (!targetItem) {
      return res.status(400).json({ success: false, message: `العنصر ${orderItem._id} غير موجود في الطلب` });
    }

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId: orderItem._id,
      status: 'pending',
    });

    await newAssignment.save();

    targetItem.status = 'assigned';
    targetItem.assignedTo = chef;
    targetItem.department = productDoc.department?._id;
    await updatedOrder.save();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
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
      .populate({
        path: 'chef',
        select: 'user',
        populate: { path: 'user', select: 'username' },
      })
      .sort({ createdAt: -1 })
      .lean();

    const validTasks = tasks.filter((task) => task.order && task.product && task.chef);
    if (validTasks.length === 0 && tasks.length > 0) {
      console.warn('تم تصفية مهام غير صالحة:', tasks.filter((task) => !task.order || !task.product || !task.chef));
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
      .populate({
        path: 'chef',
        select: 'user',
        populate: { path: 'user', select: 'username' },
      })
      .sort({ createdAt: -1 })
      .lean();

    const validTasks = tasks.filter((task) => task.order && task.product && task.chef);
    if (validTasks.length === 0 && tasks.length > 0) {
      console.warn('تم تصفية مهام غير صالحة:', tasks.filter((task) => !task.order || !task.product || !task.chef));
    }
    res.status(200).json(validTasks);
  } catch (err) {
    console.error('خطأ في جلب مهام الشيف:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const syncOrderTasks = async (orderId, io) => {
  try {
    const order = await Order.findById(orderId).populate('items.product').lean();
    if (!order) {
      console.error(`Order not found for sync: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    const taskItemIds = tasks.map((t) => t.itemId.toString());
    const missingItems = order.items.filter((item) => !taskItemIds.includes(item._id.toString()));

    const updatedOrder = await Order.findById(orderId);
    for (const item of missingItems) {
      const product = await Product.findById(item.product).lean();
      if (!product) {
        console.warn(`Product not found for item: ${item._id}`);
        continue;
      }
      const chef = await mongoose.model('Chef').findOne({ department: product.department }).lean();
      if (chef) {
        const assignment = await ProductionAssignment.create({
          order: orderId,
          product: item.product,
          chef: chef._id,
          quantity: item.quantity,
          itemId: item._id,
          status: 'pending',
        });
        const targetItem = updatedOrder.items.id(item._id);
        if (targetItem) {
          targetItem.assignedTo = chef.user;
          targetItem.status = 'assigned';
          targetItem.department = product.department;
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
            chef: { _id: chef.user, username: chef.user?.username || 'Unknown' },
            quantity: item.quantity,
            itemId: item._id,
            status: 'pending',
          });
        }
      }
    }
    await updatedOrder.save();
  } catch (err) {
    console.error(`Error syncing order tasks for order ${orderId}:`, err);
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').lean();
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }

    if (!task.order || !task.order._id) {
      console.error(`Task order is undefined or missing _id: ${taskId}`);
      return res.status(400).json({ success: false, message: 'الطلب المرتبط بالمهمة غير موجود' });
    }

    if (task.order._id.toString() !== orderId) {
      console.error(`Task does not match order: ${taskId}, orderId: ${orderId}, taskOrderId: ${task.order._id}`);
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).lean();
    if (!chefProfile) {
      console.error(`Chef profile not found for user: ${req.user.id}`);
      return res.status(403).json({ success: false, message: 'ملف الشيف غير موجود' });
    }

    if (!task.chef || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`Unauthorized: Chef does not match task: ${taskId}, taskChef: ${task.chef}, chefProfileId: ${chefProfile._id}`);
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    console.log('Updating task:', { taskId, itemId: task.itemId, status });

    const updatedTask = await ProductionAssignment.findById(taskId);
    updatedTask.status = status;
    if (status === 'in_progress') updatedTask.startedAt = new Date();
    if (status === 'completed') updatedTask.completedAt = new Date();
    await updatedTask.save();

    const order = await Order.findById(orderId);
    if (!order) {
      console.error(`Order not found: ${orderId}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`Order item not found: ${orderId}, itemId: ${task.itemId}`);
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
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `بدأ إنتاج الطلب ${order.orderNumber}`,
          { orderId },
          io
        );
      }
      io.to(`branch-${order.branch}`).emit('orderStatusUpdated', {
        orderId,
        status: 'in_production',
        user: req.user,
      });
      io.to('admin').emit('orderStatusUpdated', {
        orderId,
        status: 'in_production',
        user: req.user,
      });
      io.to('production').emit('orderStatusUpdated', {
        orderId,
        status: 'in_production',
        user: req.user,
      });
    }

    await order.save();
    await syncOrderTasks(orderId, io);

    const allAssignments = await ProductionAssignment.find({ order: orderId }).lean();
    const orderItemIds = order.items.map((i) => i._id.toString());
    const assignmentItemIds = allAssignments.map((a) => a.itemId.toString());
    const missingItems = orderItemIds.filter((id) => !assignmentItemIds.includes(id));

    console.log('Completion check:', {
      orderId,
      allTasksCompleted: allAssignments.every((a) => a.status === 'completed'),
      allOrderItemsCompleted: order.items.every((i) => i.status === 'completed'),
      assignmentsCount: allAssignments.length,
      itemsCount: order.items.length,
      missingItems,
      assignments: allAssignments.map((a) => ({ id: a._id, itemId: a.itemId, status: a.status })),
      items: order.items.map((i) => ({ id: i._id, status: i.status })),
    });

    if (allAssignments.every((a) => a.status === 'completed') && order.items.every((i) => i.status === 'completed') && order.status !== 'completed') {
      console.log(`Order ${order._id} completed: all tasks and items are completed`);
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      await order.save();

      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_completed',
          `تم اكتمال الطلب ${order.orderNumber}`,
          { orderId },
          io
        );
      }

      io.to(`branch-${order.branch}`).emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        user: req.user,
      });
      io.to('admin').emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        user: req.user,
      });
      io.to('production').emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        user: req.user,
      });
      io.to(`branch-${order.branch}`).emit('orderCompleted', {
        orderId,
        orderNumber: order.orderNumber,
      });
      io.to('admin').emit('orderCompleted', {
        orderId,
        orderNumber: order.orderNumber,
      });
      io.to('production').emit('orderCompleted', {
        orderId,
        orderNumber: order.orderNumber,
      });
    }

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
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
    io.to(`branch-${order.branch}`).emit('taskStatusUpdated', { taskId, status });
    io.to('admin').emit('taskStatusUpdated', { taskId, status });
    io.to('production').emit('taskStatusUpdated', { taskId, status });

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error('خطأ في تحديث حالة المهمة:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };