// controllers/productionController.js (improved)
const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { createNotification, notifyUsersByRoles, notifySpecificUsers } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
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
      throw new Error('معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة');
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      throw new Error('الطلب غير موجود');
    }
    if (orderDoc.status !== 'approved') {
      throw new Error('يجب الموافقة على الطلب قبل تعيين المهام');
    }

    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc) {
      throw new Error('المنتج غير موجود');
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      throw new Error('الشيف غير صالح أو غير متطابق مع قسم المنتج');
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      throw new Error(`العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج`);
    }

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
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    const branchName = (await Branch.findById(orderDoc.branch).select('name').lean())?.name || 'Unknown';

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName,
      itemId,
    };
    await emitSocketEvent(io, [`chef-${chefProfile._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);

    await createNotification(chef, 'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch }, io
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
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);

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
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);

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
      throw new Error('معرف الطلب أو المهمة غير صالح');
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) {
      throw new Error('المهمة غير موجودة');
    }
    if (!task.itemId) {
      throw new Error('معرف العنصر مفقود في المهمة');
    }
    if (task.order._id.toString() !== orderId) {
      throw new Error('المهمة لا تتطابق مع الطلب');
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      throw new Error('غير مخول لتحديث هذه المهمة');
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      throw new Error('حالة غير صالحة');
    }
    if (task.status === 'completed' && status === 'completed') {
      throw new Error('المهمة مكتملة بالفعل');
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      throw new Error(`العنصر ${task.itemId} غير موجود في الطلب`);
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date()
      });
      await notifyUsersByRoles(['admin', 'chef', 'branch'], order.branch, 'order_status_updated',
        `بدأ إنتاج الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }, io
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await Branch.findById(order.branch).select('name').lean())?.name || 'Unknown',
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', orderStatusUpdatedEvent);
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .lean();

    const branchName = (await Branch.findById(order.branch).select('name').lean())?.name || 'Unknown';

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName,
      itemId: task.itemId,
    };
    await emitSocketEvent(io, [`chef-${task.chef._id.toString()}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName,
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id.toString() },
        itemId: task.itemId,
      };
      await emitSocketEvent(io, [`chef-${task.chef._id.toString()}`, `branch-${order.branch}`, 'admin', 'production'], 'taskCompleted', taskCompletedEvent);
      await createNotification(task.chef.user.toString(), 'task_completed',
        `تم إكمال مهمة للطلب ${task.order.orderNumber}`,
        { taskId, orderId, orderNumber: task.order.orderNumber, branchId: order.branch }, io
      );
      await syncOrderTasks(orderId, io);
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

const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        const populatedItem = await Product.findById(item.product).select('name department').populate('department', '_id').lean();
        await emitSocketEvent(io, [
          `branch-${order.branch}`,
          'production',
          'admin',
          `department-${populatedItem.department?._id}`,
          'all-departments'
        ], 'itemStatusUpdated', {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: populatedItem.name,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: order.branch?.name || 'Unknown',
          sound: '/sounds/notification.mp3', // Unified sound
          vibrate: [200, 100, 200],
        });
      }
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };