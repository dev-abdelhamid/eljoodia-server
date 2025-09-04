const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { NotificationService } = require('../utils/notifications');

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    let allCompleted = true;

    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }

        await io.to(`branch-${order.branch}`).to('production').to('admin').emit('itemStatusUpdated', {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: item.product.name,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: order.branch?.name || 'Unknown',
          eventId: `${item._id}-item_status_updated`,
        });
      }
      if (task.status !== 'completed') allCompleted = false;
    }

    if (allCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
      });

      const users = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id').lean();

      for (const user of users) {
        await NotificationService.createNotification(user._id, 'order_completed_by_chefs', `تم إكمال الطلب ${order.orderNumber} بالكامل`, {
          orderId,
          branchId: order.branch,
          eventId: `${orderId}-order_completed_by_chefs`,
        }, io);
      }
    }

    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
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
      status: 'pending',
    });

    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    await io.to(`chef-${chefProfile._id}`).to('admin').to('production').to(`branch-${orderDoc.branch}`).emit('taskAssigned', {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
      eventId: `${itemId}-new_production_assigned_to_chef`,
    });

    await NotificationService.createNotification(chef, 'task_assigned', `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`, {
      taskId: newAssignment._id,
      orderId: order,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      eventId: `${newAssignment._id}-task_assigned`,
    }, io);

    await session.commitTransaction();
    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
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
        changedAt: new Date(),
      });

      const users = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id').lean();

      for (const user of users) {
        await NotificationService.createNotification(user._id, 'order_status_updated', `بدأ إنتاج الطلب ${order.orderNumber}`, {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${orderId}-order_status_updated`,
        }, io);
      }

      await io.to(`branch-${order.branch}`).to('admin').to('production').emit('orderStatusUpdated', {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        eventId: `${orderId}-order_status_updated`,
      });
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .lean();

    await io.to(`chef-${task.chef}`).to(`branch-${order.branch}`).to('admin').to('production').emit('taskStatusUpdated', {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      itemId: task.itemId,
      eventId: `${taskId}-task_status_updated`,
    });

    if (status === 'completed') {
      await io.to(`chef-${task.chef}`).to(`branch-${order.branch}`).to('admin').to('production').emit('taskCompleted', {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
        eventId: `${taskId}-task_completed`,
      });

      await NotificationService.createNotification(task.chef._id, 'task_completed', `تم إكمال مهمة للطلب ${task.order.orderNumber}`, {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        eventId: `${taskId}-task_completed`,
      }, io);
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createTask, syncOrderTasks, updateTaskStatus };