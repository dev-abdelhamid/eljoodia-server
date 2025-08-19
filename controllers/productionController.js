const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

// دالة مساعدة لإرسال أحداث السوكيت
const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach(room => io.to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, eventData);
};

// دالة مساعدة لإرسال إشعارات إلى المستخدمين
const notifyUsers = async (io, users, type, message, data) => {
  for (const user of users) {
    await createNotification(user._id, type, message, data, io);
  }
};

const createTask = async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    // التحقق من صحة البيانات
    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || 
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 || 
        !mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order);
    if (!orderDoc) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderDoc.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين المهام' });
    }

    const productDoc = await Product.findById(product).populate('department');
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef });
    const chefDoc = await User.findById(chef).populate('department');
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile || 
        chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
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

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
    };
    await emitSocketEvent(io, [`chef-${chef}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch }
    );

    res.status(201).json(populatedAssignment);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
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

const syncOrderTasks = async (orderId, io) => {
  try {
    const order = await Order.findById(orderId).populate('items.product').lean();
    if (!order) {
      console.warn(`[${new Date().toISOString()}] Order not found for sync: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    const taskItemIds = tasks.map(t => t.itemId?.toString()).filter(Boolean);
    const missingItems = order.items.filter(item => !taskItemIds.includes(item._id?.toString()) && item._id);

    console.log(`[${new Date().toISOString()}] syncOrderTasks: Checking order ${orderId}, found ${missingItems.length} missing items`);

    if (missingItems.length > 0) {
      console.warn(`[${new Date().toISOString()}] Missing assignments for order ${orderId}:`, 
        missingItems.map(i => ({ id: i._id, product: i.product?.name })));
      
      const updatedOrder = await Order.findById(orderId);
      for (const item of missingItems) {
        if (!item._id) {
          console.error(`[${new Date().toISOString()}] Invalid item in order ${orderId}: No _id found`, item);
          continue;
        }
        const product = await Product.findById(item.product);
        if (!product) {
          console.warn(`[${new Date().toISOString()}] Product not found: ${item.product}`);
          continue;
        }
        await emitSocketEvent(io, ['production', 'admin', `branch-${order.branch}`], 'missingAssignments', {
          orderId,
          itemId: item._id,
          productId: product._id,
          productName: product.name,
        });
      }
      await updatedOrder.save();
    }

    // تحديث حالة العناصر بناءً على المهام
    const updatedOrder = await Order.findById(orderId);
    for (const task of tasks) {
      const orderItem = updatedOrder.items.id(task.itemId);
      if (orderItem && orderItem.status !== task.status) {
        orderItem.status = task.status;
        if (task.status === 'in_progress') orderItem.startedAt = new Date();
        if (task.status === 'completed') orderItem.completedAt = new Date();
      }
    }
    await updatedOrder.save();

    // التحقق من اكتمال جميع المهام وعناصر الطلب
    const allAssignments = await ProductionAssignment.find({ order: orderId }).lean();
    const allTasksCompleted = allAssignments.every(a => a.status === 'completed');
    const allOrderItemsCompleted = updatedOrder.items.every(i => i.status === 'completed');

    console.log(`[${new Date().toISOString()}] syncOrderTasks: Order ${orderId} status check:`, {
      allTasksCompleted,
      allOrderItemsCompleted,
      taskCount: allAssignments.length,
      itemCount: updatedOrder.items.length,
      incompleteTasks: allAssignments.filter(a => a.status !== 'completed').map(a => ({ id: a._id, status: a.status, itemId: a.itemId })),
      incompleteItems: updatedOrder.items.filter(i => i.status !== 'completed').map(i => ({ id: i._id, status: i.status })),
    });

    if (allTasksCompleted && allOrderItemsCompleted && updatedOrder.status !== 'completed') {
      console.log(`[${new Date().toISOString()}] Completing order ${orderId} from syncOrderTasks: all tasks and items completed`);
      updatedOrder.status = 'completed';
      updatedOrder.statusHistory.push({
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date(),
      });
      await updatedOrder.save();

      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم اكتمال الطلب ${order.orderNumber} لفرع ${branch?.name || 'Unknown'}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName: branch?.name || 'Unknown' }
      );

      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', orderCompletedEvent);
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', {
        ...orderCompletedEvent,
        status: 'completed',
        user: { id: 'system' },
      });
    } else if (!allTasksCompleted || !allOrderItemsCompleted) {
      console.warn(`[${new Date().toISOString()}] Order ${orderId} not completed in syncOrderTasks:`, {
        allTasksCompleted,
        allOrderItemsCompleted,
        incompleteTasks: allAssignments.filter(a => a.status !== 'completed').map(a => ({ id: a._id, status: a.status, itemId: a.itemId })),
        incompleteItems: updatedOrder.items.filter(i => i.status !== 'completed').map(i => ({ id: i._id, status: i.status })),
      });
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in syncOrderTasks:`, err);
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

    const task = await ProductionAssignment.findById(taskId).populate('order');
    if (!task) {
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
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
    if (task.status === 'completed' && status === 'completed') {
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}`);

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save();

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    orderItem.status = status; // تأكيد تحديث حالة العنصر
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      await order.save();
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_status_updated',
        `بدأ إنتاج الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', orderStatusUpdatedEvent);
    } else {
      await order.save();
    }

    await syncOrderTasks(orderId, io);

    const allAssignments = await ProductionAssignment.find({ order: orderId }).lean();
    const allTasksCompleted = allAssignments.every(a => a.status === 'completed');
    const allOrderItemsCompleted = order.items.every(i => i.status === 'completed');

    console.log(`[${new Date().toISOString()}] Order ${orderId} status check:`, {
      allTasksCompleted,
      allOrderItemsCompleted,
      taskCount: allAssignments.length,
      itemCount: order.items.length,
      incompleteTasks: allAssignments.filter(a => a.status !== 'completed').map(a => ({ id: a._id, status: a.status, itemId: a.itemId })),
      incompleteItems: order.items.filter(i => i.status !== 'completed').map(i => ({ id: i._id, status: i.status })),
    });

    if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
      console.log(`[${new Date().toISOString()}] Completing order ${orderId}: all tasks and items completed`);
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id || 'system',
        changedAt: new Date(),
      });
      await order.save();

      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم اكتمال الطلب ${order.orderNumber} لفرع ${branch?.name || 'Unknown'}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName: branch?.name || 'Unknown' }
      );

      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', orderCompletedEvent);
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', {
        ...orderCompletedEvent,
        status: 'completed',
        user: req.user || { id: 'system' },
      });
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

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      itemId: task.itemId,
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskCompleted', taskCompletedEvent);
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };