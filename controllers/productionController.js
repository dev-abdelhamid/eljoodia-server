const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { isValidObjectId, emitSocketEvent, notifyUsers } = require('../utils/common');

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!isValidObjectId(order) || !isValidObjectId(product) || !isValidObjectId(chef) || !quantity || quantity < 1 || !isValidObjectId(itemId)) {
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
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile || chefProfile.department.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id,
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
      chef: chefDoc._id,
      quantity,
      itemId,
      status: 'pending',
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chefDoc._id;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'username')
      .lean();

    const taskAssignedEvent = {
      _id: `${itemId}-taskAssigned`,
      type: 'info',
      message: `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      data: {
        taskId: newAssignment._id,
        orderId: order,
        orderNumber: orderDoc.orderNumber,
        branchId: orderDoc.branch,
        branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'غير معروف',
        itemId,
        productName: productDoc.name,
        eventId: `${itemId}-taskAssigned`,
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      },
      read: false,
      createdAt: new Date().toISOString(),
    };
    await emitSocketEvent(io, [`chef-${chefDoc._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    await notifyUsers(io, [{ _id: chefDoc._id }], 'info', taskAssignedEvent.message, taskAssignedEvent.data, true);

    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, {
      error: err.message,
      stack: err.stack,
    });
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
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'username')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter((task) => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, tasks.filter((task) => !task.order || !task.product || !task.itemId).map((t) => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'username')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter((task) => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`, tasks.filter((task) => !task.order || !task.product || !task.itemId).map((t) => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      stack: err.stack,
    });
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

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
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
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
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
        changedAt: new Date(),
        notes: 'Production started',
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'in_production'`);
      const usersToNotify = await User.find({ role: { $in: ['chef', 'admin', 'production'] } }).select('_id').lean();
      const eventData = {
        _id: `${orderId}-orderStatusUpdated-in_production`,
        type: 'info',
        message: `بدأ إنتاج الطلب ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
          eventId: `${orderId}-orderStatusUpdated-in_production`,
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
        },
        read: false,
        createdAt: new Date().toISOString(),
      };
      await notifyUsers(io, usersToNotify, 'info', `بدأ إنتاج الطلب ${order.orderNumber}`, eventData.data, true);
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', eventData);
    }

    if (order.items.every((item) => item.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: 'All items completed',
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'completed'`);
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'branch', 'chef'] }, branch: order.branch }).select('_id').lean();
      const eventData = {
        _id: `${orderId}-orderCompleted`,
        type: 'success',
        message: `تم إكمال الطلب ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
          status: 'completed',
          eventId: `${orderId}-orderCompleted`,
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
        },
        read: false,
        createdAt: new Date().toISOString(),
      };
      await notifyUsers(io, usersToNotify, 'success', `تم إكمال الطلب ${order.orderNumber}`, eventData.data, true);
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`, `chef-${req.user.id}`], 'orderCompleted', eventData);
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'username')
      .lean();

    const taskStatusUpdatedEvent = {
      _id: `${taskId}-taskStatusUpdated-${status}`,
      type: 'info',
      message: `تم تحديث حالة المهمة للطلب ${task.order.orderNumber} إلى ${status}`,
      data: {
        taskId,
        status,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
        itemId: task.itemId,
        productName: populatedTask.product.name,
        eventId: `${taskId}-taskStatusUpdated-${status}`,
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
      },
      read: false,
      createdAt: new Date().toISOString(),
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], 'itemStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        _id: `${taskId}-taskCompleted`,
        type: 'success',
        message: `تم إكمال مهمة للطلب ${task.order.orderNumber}`,
        data: {
          taskId,
          orderId,
          orderNumber: task.order.orderNumber,
          branchId: order.branch,
          branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
          completedAt: new Date().toISOString(),
          chef: { _id: task.chef._id },
          itemId: task.itemId,
          productName: populatedTask.product.name,
          eventId: `${taskId}-taskCompleted`,
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
        },
        read: false,
        createdAt: new Date().toISOString(),
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], 'taskCompleted', taskCompletedEvent);
      await notifyUsers(io, [{ _id: task.chef._id }], 'success', taskCompletedEvent.message, taskCompletedEvent.data, true);
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session).lean();
    for (const task of tasks) {
      const item = order.items.find((i) => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await emitSocketEvent(io, ['admin', 'production', `department-${item.product.department?._id}`, `branch-${order.branch}`, `chef-${task.chef}`, 'all-departments'], 'itemStatusUpdated', {
          _id: `${task._id}-itemStatusUpdated-${task.status}`,
          type: 'info',
          message: `تم تحديث حالة العنصر ${item.product.name} في الطلب ${order.orderNumber} إلى ${task.status}`,
          data: {
            orderId,
            itemId: item._id,
            status: task.status,
            productName: item.product.name,
            orderNumber: order.orderNumber,
            branchId: order.branch,
            branchName: order.branch?.name || 'غير معروف',
            eventId: `${task._id}-itemStatusUpdated-${task.status}`,
            sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
            vibrate: [200, 100, 200],
          },
          read: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
    if (order.items.every((item) => item.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
        notes: 'All items completed via sync',
      });
      await order.save({ session });
      const eventData = {
        _id: `${orderId}-orderCompleted`,
        type: 'success',
        message: `تم إكمال الطلب ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: order.branch?.name || 'غير معروف',
          status: 'completed',
          eventId: `${orderId}-orderCompleted`,
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
        },
        read: false,
        createdAt: new Date().toISOString(),
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`, 'all-departments'], 'orderCompleted', eventData);
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'branch', 'chef'] }, branch: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'success', `تم إكمال الطلب ${order.orderNumber}`, eventData.data, true);
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };