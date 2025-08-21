const mongoose = require('mongoose');
const Order = require('../models/Order');
const ProductionAssignment = require('../models/ProductionAssignment');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');
const { emitSocketEvent } = require('../utils/socket');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;

    if (!isValidObjectId(order) || !isValidObjectId(product) || !isValidObjectId(chef) || !isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid IDs:`, { order, product, chef, itemId });
      return res.status(400).json({ success: false, message: 'معرفات غير صالحة' });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${order}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const task = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
      itemId,
      status: 'pending',
    });
    await task.save({ session });

    const orderItem = orderDoc.items.find((i) => i._id.toString() === itemId);
    if (!orderItem) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order item not found: ${itemId}`);
      return res.status(400).json({ success: false, message: 'العنصر غير موجود في الطلب' });
    }

    orderItem.assignedTo = chef;
    orderItem.status = 'assigned';
    orderDoc.markModified('items');
    await orderDoc.save({ session });

    const populatedTask = await ProductionAssignment.findById(task._id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name department')
      .populate('chef', 'username')
      .lean();

    const io = req.app.get('io');
    const eventData = {
      taskId: task._id,
      orderId: order,
      itemId,
      orderNumber: populatedTask.order.orderNumber,
      productName: populatedTask.product.name,
      chefId: chef,
      status: 'pending',
      branchId: populatedTask.order.branch,
      sound: '/notification.mp3',
      vibrate: [400, 100, 400],
    };
    await emitSocketEvent(io, [
      `chef-${chef}`,
      `branch-${populatedTask.order.branch}`,
      'production',
      'admin',
      `department-${populatedTask.product.department?._id}`,
    ], 'taskAssigned', eventData);

    await createNotification(
      chef,
      'task_assigned',
      `تم تعيينك لإنتاج ${populatedTask.product.name} للطلب ${populatedTask.order.orderNumber}`,
      eventData,
      io
    );

    await session.commitTransaction();
    res.status(201).json(populatedTask);
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
    const query = {};
    if (req.user.role === 'production') query.status = { $in: ['pending', 'in_progress'] };
    if (req.query.orderId) query.order = req.query.orderId;
    if (req.query.chefId) query.chef = req.query.chefId;

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name department')
      .populate('chef', 'username')
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chef ID: ${chefId}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    if (req.user.id !== chefId && req.user.role !== 'admin' && req.user.role !== 'production') {
      console.error(`[${new Date().toISOString()}] Unauthorized access:`, { userId: req.user.id, chefId });
      return res.status(403).json({ success: false, message: 'غير مخول لعرض مهام هذا الشيف' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber branch')
      .populate('product', 'name department')
      .populate('chef', 'username')
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, taskId } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid task status: ${status}`);
      return res.status(400).json({ success: false, message: 'حالة المهمة غير صالحة' });
    }

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const task = await ProductionAssignment.findById(taskId).session(session);
    if (!task || task.order.toString() !== orderId || task.chef.toString() !== req.user.id) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid task or unauthorized:`, { taskId, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'المهمة غير صالحة أو غير مخول' });
    }

    // تحديث حالة العنصر في الطلب
    const item = order.items.find((i) => i._id.toString() === task.itemId.toString());
    if (!item) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
      return res.status(400).json({ success: false, message: 'العنصر غير موجود في الطلب' });
    }

    item.status = status;
    if (status === 'in_progress' && !item.startedAt) item.startedAt = new Date();
    if (status === 'completed' && !item.completedAt) item.completedAt = new Date();

    // تحديث حالة المهمة
    task.status = status;
    await task.save({ session });

    // التحقق من حالة جميع العناصر
    const allItemsCompleted = order.items.every((i) => i.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed' && order.status !== 'in_transit' && order.status !== 'delivered') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    } else if (order.items.some((i) => i.status === 'in_progress') && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }

    order.markModified('items');
    await order.save({ session });

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .lean();

    const io = req.app.get('io');
    const eventData = {
      taskId,
      itemId: task.itemId,
      orderId,
      status,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      productName: item.product.name,
      sound: '/notification.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [
      `branch-${order.branch}`,
      'production',
      'admin',
      `chef-${req.user.id}`,
      `department-${item.product.department?._id}`,
    ], 'taskStatusUpdated', eventData);

    if (allItemsCompleted) {
      const completedEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'production', 'admin'], 'orderCompleted', completedEventData);
    }

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
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
    const order = await Order.findById(orderId)
      .populate('items.product', 'name department')
      .session(session);
    if (!order) return;

    for (const item of order.items) {
      if (item.assignedTo && !item.status) {
        item.status = 'assigned';
        await ProductionAssignment.findOneAndUpdate(
          { order: orderId, itemId: item._id },
          { chef: item.assignedTo, product: item.product._id, quantity: item.quantity, status: 'pending', itemId: item._id, order: orderId },
          { upsert: true, session }
        );

        const eventData = {
          taskId: item._id,
          orderId,
          itemId: item._id,
          orderNumber: order.orderNumber,
          productName: item.product.name,
          chefId: item.assignedTo,
          status: 'pending',
          branchId: order.branch,
          sound: '/notification.mp3',
          vibrate: [400, 100, 400],
        };
        await emitSocketEvent(io, [
          `chef-${item.assignedTo}`,
          `branch-${order.branch}`,
          'production',
          'admin',
          `department-${item.product.department?._id}`,
        ], 'taskAssigned', eventData);
      }
    }

    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };