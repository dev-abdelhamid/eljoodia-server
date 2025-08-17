const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const Notification = require('../models/Notification');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
};

const createNotification = async (to, type, message, data) => {
  const notification = new Notification({
    user: to,
    type,
    message,
    data,
    read: false,
  });
  await notification.save();
  const io = require('../app').io;
  io.to(`user-${to}`).emit('newNotification', notification);
  return notification;
};

exports.createOrder = async (req, res) => {
  try {
    const { orderNumber, items, status, notes, priority, branchId } = req.body;
    let branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة' });
    }

    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        acc.push(item);
      }
      return acc;
    }, []);

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending',
      })),
      status: 'pending',
      notes: notes?.trim(),
      priority: priority || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
    });

    await newOrder.save();
    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .lean();

    const notifyRoles = ['production', 'admin'];
    const usersToNotify = await User.find({ role: { $in: notifyRoles } }).select('_id');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_created',
        `طلب جديد ${orderNumber} تم إنشاؤه بواسطة الفرع ${populatedOrder.branch.name}`,
        { orderId: newOrder._id }
      );
    }

    req.app.get('io').to(branch.toString()).emit('orderCreated', populatedOrder);
    res.status(201).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في إنشاء الطلب:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

exports.getOrders = async (req, res) => {
  try {
    const { status, branch } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    orders.forEach(order => {
      order.items.forEach(item => {
        item.isCompleted = item.status === 'completed';
      });
    });

    res.status(200).json(orders);
  } catch (err) {
    console.error('خطأ في جلب الطلبات:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      return res.status(400).json({ success: false, message: `الانتقال من ${order.status} إلى ${status} غير مسموح` });
    }

    order.status = status;
    if (notes) order.notes = notes.trim();
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes,
      changedAt: new Date(),
    });
    await order.save();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    let notifyRoles = [];
    if (status === 'approved') notifyRoles = ['production'];
    if (status === 'in_production') notifyRoles = ['chef', 'branch'];
    if (status === 'in_transit') notifyRoles = ['branch', 'admin'];
    if (status === 'cancelled') notifyRoles = ['branch', 'production', 'admin'];

    if (notifyRoles.length > 0) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles } }).select('_id');
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
          { orderId: id }
        );
      }
    }

    req.app.get('io').to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في تحديث حالة الطلب:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

exports.confirmDelivery = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch');
    if (!order || order.status !== 'in_transit') {
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    for (const item of order.items) {
      await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        { $inc: { currentStock: item.quantity } },
        { upsert: true }
      );
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({ status: 'delivered', changedBy: req.user.id });
    await order.save();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_delivered',
        `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${order.branch.name}`,
        { orderId: id }
      );
    }

    req.app.get('io').to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status: 'delivered', user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في تأكيد التسليم:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

exports.approveReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(id).populate('order');
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    if (status === 'approved') {
      for (const item of returnRequest.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order.branch, product: item.product },
          { $inc: { currentStock: -item.quantity } },
          { upsert: true }
        );
      }
    }

    returnRequest.status = status;
    if (reviewNotes) returnRequest.reviewNotes = reviewNotes.trim();
    await returnRequest.save();

    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order.branch }).select('_id');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order.orderNumber}`,
        { returnId: id, orderId: returnRequest.order._id }
      );
    }

    req.app.get('io').to(returnRequest.order.branch.toString()).emit('returnStatusUpdated', { returnId: id, status, returnNote: reviewNotes });
    res.status(200).json(returnRequest);
  } catch (err) {
    console.error('خطأ في الموافقة على الإرجاع:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

exports.getChefTasks = async (req, res) => {
  try {
    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id });
    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'ملف الشيف غير موجود' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefProfile._id })
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .lean();

    tasks.forEach(task => {
      task.isCompleted = task.status === 'completed';
    });

    res.status(200).json(tasks);
  } catch (err) {
    console.error('خطأ في جلب مهام الشيف:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

exports.updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { taskId } = req.params;

    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'معرف المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').populate('product');
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

    console.log('Updating task:', { taskId, itemId: task.itemId, status });

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(task.order._id);
    if (order) {
      const orderItem = order.items.id(task.itemId);
      if (!orderItem) {
        console.log('Order item not found for itemId:', task.itemId);
        return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
      }

      orderItem.status = status;
      if (status === 'in_progress') orderItem.startedAt = new Date();
      if (status === 'completed') orderItem.completedAt = new Date();
      await order.save();

      const allAssignments = await ProductionAssignment.find({ order: task.order });
      const allTasksCompleted = allAssignments.every(a => a.status === 'completed');
      const allOrderItemsCompleted = order.items.every(i => i.status === 'completed');

      console.log('Completion check:', {
        allTasksCompleted,
        allOrderItemsCompleted,
        assignments: allAssignments.map(a => ({ id: a._id, status: a.status })),
        items: order.items.map(i => ({ id: i._id, status: i.status })),
      });

      if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
        console.log(`Order ${order._id} completed: all tasks and items are completed`);
        order.status = 'completed';
        order.statusHistory.push({ status: 'completed', changedBy: req.user.id });
        await order.save();

        const notifyRoles = ['production', 'admin', 'branch'];
        const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch }).select('_id');
        for (const user of usersToNotify) {
          await createNotification(
            user._id,
            'order_completed',
            `تم إكمال الطلب ${order.orderNumber} بالكامل`,
            { orderId: order._id }
          );
        }

        req.app.get('io').to(order.branch.toString()).emit('orderStatusUpdated', { orderId: order._id, status: 'completed' });
      }
    }

    if (status === 'completed') {
      const productionUsers = await User.find({ role: 'production' }).select('_id');
      for (const user of productionUsers) {
        await createNotification(
          user._id,
          'task_completed',
          `تم إكمال مهمة إنتاج ${task.product.name} في الطلب ${task.order.orderNumber} بواسطة الشيف`,
          { taskId, orderId: task.order._id }
        );
      }
    }

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .lean();

    req.app.get('io').to(task.order.branch.toString()).emit('taskStatusUpdated', { taskId, status });
    req.app.get('io').to('admin').emit('taskStatusUpdated', { taskId, status });
    req.app.get('io').to('production').emit('taskStatusUpdated', { taskId, status });
    res.status(200).json(populatedTask);
  } catch (err) {
    console.error('خطأ في تحديث حالة المهمة:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

exports.assignChefs = async (req, res) => {
  try {
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    if (!items?.length) {
      return res.status(400).json({ success: false, message: 'مصفوفة العناصر مطلوبة' });
    }

    console.log('Received items in assignChefs:', items);

    const order = await Order.findById(orderId)
      .populate({
        path: 'items.product',
        populate: { path: 'department', select: 'name code isActive' },
      })
      .populate('branch');
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        console.log('Invalid itemId or assignedTo:', { itemId: item.itemId, assignedTo: item.assignedTo });
        return res.status(400).json({ success: false, message: `معرفات غير صالحة: itemId=${item.itemId}, assignedTo=${item.assignedTo}` });
      }

      const orderItem = order.items.id(item.itemId);
      if (!orderItem) {
        console.log('Order item not found for itemId:', item.itemId);
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في الطلب` });
      }

      const chef = await User.findById(item.assignedTo).populate('department');
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo });
      const product = orderItem.product;

      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department._id.toString() !== product.department._id.toString()) {
        return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع القسم' });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      console.log('Creating ProductionAssignment:', { orderId, itemId: item.itemId, chef: chefProfile._id, product: product._id });
      const assignment = await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId: item.itemId },
        { chef: chefProfile._id, product: product._id, quantity: orderItem.quantity, status: 'pending' },
        { upsert: true, new: true }
      );

      await createNotification(
        item.assignedTo,
        'task_assigned',
        `تم تعيينك لإنتاج ${product.name} في الطلب ${order.orderNumber}`,
        { taskId: assignment._id, orderId }
      );

      req.app.get('io').to(`chef-${chefProfile._id}`).emit('taskAssigned', {
        orderId,
        product,
        chefId: chefProfile._id,
      });
    }

    await order.save();

    if (order.items.every(i => i.status === 'assigned') && order.status !== 'in_production') {
      order.status = 'in_production';
      order.statusHistory.push({ status: 'in_production', changedBy: req.user.id });
      await order.save();

      const usersToNotify = await User.find({ role: { $in: ['chef', 'admin'] } }).select('_id');
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `بدأ إنتاج الطلب ${order.orderNumber}`,
          { orderId }
        );
      }

      req.app.get('io').to(order.branch.toString()).emit('orderStatusUpdated', { orderId, status: 'in_production' });
    }

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .lean();

    req.app.get('io').to(order.branch.toString()).emit('orderUpdated', populatedOrder);
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في تعيين الشيفات:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  createOrder,
  getOrders,
  updateOrderStatus,
  confirmDelivery,
  approveReturn,
  getChefTasks,
  updateTaskStatus,
  assignChefs,
};