const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms, eventData });
};

const notifyUsers = async (io, users, type, message, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, { users: users.map(u => u._id), message, data });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, { ...data, eventId: `${data.orderId || data.taskId || data.returnId || 'generic'}-${type}-${user._id}` }, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err);
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) ||
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين المهام' });
    }

    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc || !productDoc.department) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product or department not found: ${product}`);
      return res.status(404).json({ success: false, message: 'المنتج أو القسم غير موجود' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department?._id.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id
      });
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
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
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate({ path: 'chef', populate: { path: 'user', select: '_id' } })
      .lean();

    const taskAssignedEvent = {
      _id: newAssignment._id,
      type: 'task_assigned',
      orderId: orderDoc._id,
      taskId: newAssignment._id,
      branchId: orderDoc.branch,
      orderNumber: orderDoc.orderNumber,
      productName: productDoc.name,
      chef: { _id: chefProfile.user },
      itemId,
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [
      `chef-${chefProfile._id}`,
      `user-${chef}`,
      `branch-${orderDoc.branch}`,
      'admin',
      'production',
      `department-${productDoc.department._id}`
    ], 'taskAssigned', taskAssignedEvent);

    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      {
        taskId: newAssignment._id,
        orderId: order,
        orderNumber: orderDoc.orderNumber,
        branchId: orderDoc.branch,
        chefId: chef,
        productId: product,
        productName: productDoc.name,
        eventId: `${newAssignment._id}-task_assigned-${chef}`
      }
    );

    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber _id branch')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate({ path: 'chef', populate: { path: 'user', select: '_id' } })
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id branch')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate({ path: 'chef', populate: { path: 'user', select: '_id' } })
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name department')
      .populate({ path: 'chef', populate: { path: 'user', select: '_id' } })
      .session(session);
    if (!task || !task.order || !task.product) {
      console.error(`[${new Date().toISOString()}] Task not found or invalid: ${taskId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
    }
    if (task.order._id.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match order ${orderId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef._id.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef._id });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
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
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
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
      const usersToNotify = await User.find({ $or: [{ role: 'admin' }, { role: 'branch', branch: order.branch }, { role: 'chef', department: task.product.department._id }] }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_status_updated',
        `بدأ إنتاج الطلب ${order.orderNumber}`,
        {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${orderId}-order_status_updated-in_production-${Date.now()}`
        }
      );
      const orderStatusUpdatedEvent = {
        _id: `${orderId}-orderStatusUpdated-${Date.now()}`,
        type: 'order_status_updated',
        orderId,
        status: 'in_production',
        orderNumber: order.orderNumber,
        branchId: order.branch,
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      };
      await emitSocketEvent(io, [
        `branch-${order.branch}`,
        'admin',
        'production',
        `department-${task.product.department._id}`
      ], 'orderStatusUpdated', orderStatusUpdatedEvent);
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate({ path: 'chef', populate: { path: 'user', select: '_id' } })
      .lean();

    const taskStatusUpdatedEvent = {
      _id: `${taskId}-taskStatusUpdated-${Date.now()}`,
      type: 'task_status_updated',
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      productName: task.product.name,
      chef: { _id: task.chef.user._id },
      itemId: task.itemId,
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [
      `chef-${task.chef._id}`,
      `branch-${order.branch}`,
      'admin',
      'production',
      `department-${task.product.department._id}`
    ], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        _id: `${taskId}-taskCompleted-${Date.now()}`,
        type: 'task_completed',
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        productName: task.product.name,
        chef: { _id: task.chef.user._id },
        itemId: task.itemId,
        read: false,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      };
      await emitSocketEvent(io, [
        `chef-${task.chef._id}`,
        `branch-${order.branch}`,
        'admin',
        'production',
        `department-${task.product.department._id}`
      ], 'taskCompleted', taskCompletedEvent);
      await notifyUsers(io, [
        { _id: task.chef.user._id },
        ...(await User.find({ role: 'admin' }).select('_id').lean()),
        ...(await User.find({ role: 'production', department: task.product.department._id }).select('_id').lean()),
        ...(await User.find({ role: 'branch', branch: order.branch }).select('_id').lean())
      ], 'task_completed',
        `تم إكمال مهمة (${task.product.name}) في الطلب ${task.order.orderNumber}`,
        {
          taskId,
          orderId,
          orderNumber: task.order.orderNumber,
          branchId: order.branch,
          chefId: task.chef.user._id,
          productName: task.product.name,
          eventId: `${taskId}-task_completed-${Date.now()}`
        }
      );
      await syncOrderTasks(orderId, io, session);
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).populate('branch', 'name').session(session);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId })
      .populate('product', 'name department')
      .populate({ path: 'chef', populate: { path: 'user', select: '_id' } })
      .session(session);

    let allCompleted = true;
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await emitSocketEvent(io, [
          `branch-${order.branch?._id}`,
          'production',
          'admin',
          `department-${task.product.department?._id}`,
          `chef-${task.chef._id}`
        ], 'itemStatusUpdated', {
          _id: `${task.itemId}-itemStatusUpdated-${Date.now()}`,
          type: 'item_status_updated',
          orderId,
          itemId: task.itemId,
          status: task.status,
          productName: task.product.name,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          chefId: task.chef.user._id,
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
        });
      }
      if (task.status !== 'completed') {
        allCompleted = false;
      }
    }

    if (allCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedAt: new Date()
      });
      console.log(`[${new Date().toISOString()}] Order ${orderId} marked as completed`);
      const usersToNotify = await User.find({ $or: [{ role: 'admin' }, { role: 'branch', branch: order.branch }, { role: 'production' }] }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم إكمال الطلب ${order.orderNumber}`,
        {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          eventId: `${orderId}-order_completed-${Date.now()}`
        }
      );
      await emitSocketEvent(io, [
        `branch-${order.branch?._id}`,
        'admin',
        'production'
      ], 'orderCompleted', {
        _id: `${orderId}-orderCompleted-${Date.now()}`,
        type: 'order_completed',
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      });
    }

    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };