const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { emitSocketEvent, notifyUsers } = require('../utils/notifications');

/**
 * إنشاء مهمة إنتاج
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const createTask = async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');
    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) ||
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }
    const orderDoc = await Order.findById(order).lean();
    if (!orderDoc) {
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderDoc.status !== 'approved') {
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين المهام' });
    }
    const productDoc = await Product.findById(product).populate('department').lean();
    if (!productDoc) {
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).lean();
    const chefDoc = await User.findById(chef).populate('department').lean();
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefProfile.department.toString() !== productDoc.department._id.toString()) {
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id
      });
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }
    const orderItem = orderDoc.items.find(i => i._id.toString() === itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
    }
    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });
    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefDoc._id,
      quantity,
      itemId,
      status: 'pending'
    });
    await newAssignment.save();
    await Order.updateOne(
      { _id: order, 'items._id': itemId },
      { $set: { 'items.$.status': 'assigned', 'items.$.assignedTo': chefDoc._id, 'items.$.department': productDoc.department._id } }
    );
    await syncOrderTasks(order, io);
    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'username')
      .lean();
    const taskAssignedEvent = {
      orderId: order,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'غير معروف',
      taskId: newAssignment._id,
      itemId,
      productName: productDoc.name,
      quantity,
      chefId: chefDoc._id,
      eventId: `${itemId}-taskAssigned`
    };
    await notifyUsers(
      io,
      [{ _id: chefDoc._id }],
      'taskAssigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      taskAssignedEvent,
      false
    );
    await emitSocketEvent(io, [`chef-${chefDoc._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating task:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * استرجاع جميع المهام
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'username')
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
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * استرجاع مهام شيف معين
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }
    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'username')
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
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * تحديث حالة المهمة
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');
    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }
    const task = await ProductionAssignment.findById(taskId).populate('order').lean();
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
    }
    if (task.order._id.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match order ${orderId}`);
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }
    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).lean();
    if (!chefProfile || task.chef.toString() !== req.user.id) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed`);
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
    }
    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}`);
    const updateData = { status };
    if (status === 'in_progress') updateData.startedAt = new Date();
    if (status === 'completed') updateData.completedAt = new Date();
    await ProductionAssignment.updateOne({ _id: taskId }, { $set: updateData });
    const order = await Order.findById(orderId);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    const orderItem = order.items.find(i => i._id.toString() === task.itemId.toString());
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
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
        notes: 'Production started',
      });
      const usersToNotify = await User.find({ role: { $in: ['chef', 'admin', 'production'] } }).select('_id').lean();
      const eventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
        status: 'in_production',
        eventId: `${orderId}-orderStatusUpdated-in_production`,
      };
      await notifyUsers(io, usersToNotify, 'orderStatusUpdated', `بدأ إنتاج الطلب ${order.orderNumber}`, eventData, false);
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', eventData);
    }
    if (order.items.every(item => item.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: 'All items completed',
      });
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production', 'chef'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id').lean();
      const eventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
        status: 'completed',
        eventId: `${orderId}-orderCompleted`,
      };
      await notifyUsers(io, usersToNotify, 'orderCompleted', `تم إكمال الطلب ${order.orderNumber}`, eventData, false);
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`, `chef-${req.user.id}`], 'orderCompleted', eventData);
    }
    order.markModified('items');
    await order.save();
    await syncOrderTasks(orderId, io);
    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'username')
      .lean();
    const taskStatusUpdatedEvent = {
      taskId,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
      itemId: task.itemId,
      productName: populatedTask.product.name,
      status,
      chefId: task.chef._id,
      eventId: `${taskId}-taskStatusUpdated-${status}`,
    };
    await notifyUsers(
      io,
      [{ _id: task.chef._id }],
      'itemStatusUpdated',
      `تم تحديث حالة العنصر ${populatedTask.product.name} في الطلب ${task.order.orderNumber} إلى ${status}`,
      taskStatusUpdatedEvent,
      false
    );
    await emitSocketEvent(io, [`chef-${task.chef._id}`, 'admin', 'production', `branch-${order.branch}`], 'itemStatusUpdated', taskStatusUpdatedEvent);
    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
        completedAt: new Date().toISOString(),
        chefId: task.chef._id,
        itemId: task.itemId,
        productName: populatedTask.product.name,
        eventId: `${taskId}-taskCompleted`,
      };
      await notifyUsers(
        io,
        [{ _id: task.chef._id }],
        'taskCompleted',
        `تم إكمال مهمة للطلب ${task.order.orderNumber}`,
        taskCompletedEvent,
        false
      );
      await emitSocketEvent(io, [`chef-${task.chef._id}`, 'admin', 'production', `branch-${order.branch}`], 'taskCompleted', taskCompletedEvent);
    }
    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating task status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * مزامنة مهام الطلب
 * @param {string} orderId - معرف الطلب
 * @param {Object} io - كائن Socket.IO
 */
const syncOrderTasks = async (orderId, io) => {
  try {
    const order = await Order.findById(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        const product = await Product.findById(item.product).select('name').lean();
        const eventData = {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: product.name,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
          chefId: task.chef,
          eventId: `${task._id}-itemStatusUpdated-${task.status}`,
        };
        await notifyUsers(
          io,
          [{ _id: task.chef }],
          'itemStatusUpdated',
          `تم تحديث حالة العنصر ${product.name} في الطلب ${order.orderNumber} إلى ${task.status}`,
          eventData,
          false
        );
        await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`, `chef-${task.chef}`], 'itemStatusUpdated', eventData);
      }
    }
    if (order.items.every(item => item.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
        notes: 'All items completed via sync',
      });
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id').lean();
      const eventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
        status: 'completed',
        eventId: `${orderId}-orderCompleted`,
      };
      await notifyUsers(io, usersToNotify, 'orderCompleted', `تم إكمال الطلب ${order.orderNumber}`, eventData, false);
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompleted', eventData);
    }
    order.markModified('items');
    await order.save();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };