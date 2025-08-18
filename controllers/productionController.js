const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const createTask = async (req, res) => {
  try {
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 || !mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
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
    };
    io.to(`chef-${chef}`).emit('taskAssigned', taskAssignedEvent);
    io.to('admin').emit('taskAssigned', taskAssignedEvent);
    io.to('production').emit('taskAssigned', taskAssignedEvent);
    io.to(`branch-${orderDoc.branch}`).emit('taskAssigned', taskAssignedEvent);
    await createNotification(
      chef,
      'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch },
      io
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
      .sort({ updatedAt: -1 })  // تعديل: ترتيب بالأحدث نشاطاً (updatedAt)
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length === 0 && tasks.length > 0) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, tasks.filter(task => !task.order || !task.product || !task.itemId));
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
      .sort({ updatedAt: -1 })  // تعديل: ترتيب بالأحدث نشاطاً (updatedAt)
      .lean();
    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length === 0 && tasks.length > 0) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, tasks.filter(task => !task.order || !task.product || !task.itemId));
    }
    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const syncOrderTasks = async (orderId, io) => {
  try {
    const order = await Order.findById(orderId).populate('items.product');
    if (!order) {
      console.warn(`[${new Date().toISOString()}] Order not found for sync: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).lean();
    const taskItemIds = tasks.map(t => t.itemId?.toString()).filter(Boolean);
    const missingItems = order.items.filter(item => !taskItemIds.includes(item._id?.toString()) && item._id);

    if (missingItems.length > 0) {
      console.warn(`[${new Date().toISOString()}] syncOrderTasks: Missing assignments for items in order ${orderId}`, missingItems.map(i => i._id));
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
        // تعديل رئيسي: نبحث عن شيفات في القسم، لو واحد بس، نعينه افتراضياً، غير كده نرسل إشعار للإنتاج بدون تعيين
        const chefsInDept = await mongoose.model('Chef').find({ department: product.department }).lean();
        if (chefsInDept.length === 1) {
          const chef = chefsInDept[0];
          const assignment = await ProductionAssignment.create({
            order: orderId,
            product: item.product,
            chef: chef._id,
            quantity: item.quantity,
            itemId: item._id,
            status: 'pending',
          });
          item.assignedTo = chef.user;
          item.status = 'assigned';
          item.department = product.department;
          await createNotification(
            chef.user,
            'task_assigned',
            `تم تعيينك لإنتاج ${product.name} في الطلب ${order.orderNumber} (افتراضياً لأنك الشيف الوحيد)`,
            { taskId: assignment._id, orderId, orderNumber: order.orderNumber, branchId: order.branch },
            io
          );
          const taskAssignedEvent = {
            _id: assignment._id,
            order: { _id: orderId, orderNumber: order.orderNumber },
            product: { _id: product._id, name: product.name },
            chef: { _id: chef.user, username: (await User.findById(chef.user).select('username').lean())?.username || 'Unknown' },
            quantity: item.quantity,
            itemId: item._id,
            status: 'pending',
            branchId: order.branch,
            branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
          };
          io.to(`chef-${chef.user}`).emit('taskAssigned', taskAssignedEvent);
          io.to('production').emit('taskAssigned', taskAssignedEvent);
          io.to('admin').emit('taskAssigned', taskAssignedEvent);
          io.to(`branch-${order.branch}`).emit('taskAssigned', taskAssignedEvent);
        } else {
          // لو أكثر من شيف أو مش موجود، نرسل إشعار للإنتاج للتعيين اليدوي
          console.warn(`[${new Date().toISOString()}] No single chef for department: ${product.department}, sending notification`);
          io.to('production').emit('missingAssignments', { orderId, itemId: item._id, productId: product._id });
          io.to('admin').emit('missingAssignments', { orderId, itemId: item._id, productId: product._id });
          io.to(`branch-${order.branch}`).emit('missingAssignments', { orderId, itemId: item._id, productId: product._id });
        }
      }
      await order.save();
    } else {
      console.log(`[${new Date().toISOString()}] syncOrderTasks: All items in order ${orderId} have assignments`);
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

    console.log(`[${new Date().toISOString()}] Updating task:`, { taskId, itemId: task.itemId, status });

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
      console.error(`[${new Date().toISOString()}] Order item not found:`, { orderId, itemId: task.itemId });
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
          { orderId, orderNumber: order.orderNumber, branchId: order.branch },
          io
        );
      }
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      };
      io.to(`branch-${order.branch}`).emit('orderStatusUpdated', orderStatusUpdatedEvent);
      io.to('admin').emit('orderStatusUpdated', orderStatusUpdatedEvent);
      io.to('production').emit('orderStatusUpdated', orderStatusUpdatedEvent);
    }

    await order.save();

    await syncOrderTasks(orderId, io);

    const allAssignments = await ProductionAssignment.find({ order: orderId }).lean();
    const orderItemIds = order.items.map(i => i._id.toString());
    const assignmentItemIds = allAssignments.map(a => a.itemId?.toString()).filter(Boolean);
    const missingItems = orderItemIds.filter(id => !assignmentItemIds.includes(id));

    if (missingItems.length > 0) {
      console.warn(`[${new Date().toISOString()}] Items without assignments:`, { orderId, missingItems });
      io.to('production').emit('missingAssignments', { orderId, missingItems });
      io.to('admin').emit('missingAssignments', { orderId, missingItems });
      io.to(`branch-${order.branch}`).emit('missingAssignments', { orderId, missingItems });
    }

    // تعديل: تحقق دقيق للاكتمال، حتى لو أكثر من عنصر، وتحديث الطلب تلقائياً إلى completed
    const allTasksCompleted = allAssignments.every(a => a.status === 'completed');
    const allOrderItemsCompleted = order.items.every(i => i.status === 'completed');

    if (allTasksCompleted && allOrderItemsCompleted && order.status !== 'completed') {
      console.log(`[${new Date().toISOString()}] Order ${order._id} completed: all tasks and items are completed`);
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      await order.save();

      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_completed',
          `تم اكتمال الطلب ${order.orderNumber} لفرع ${branch?.name || 'Unknown'}`,
          { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName: branch?.name || 'Unknown' },
          io
        );
      }

      const orderCompletedEvent = {
        orderId: order._id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
      };

      io.to(`branch-${order.branch}`).emit('orderCompleted', orderCompletedEvent);
      io.to('admin').emit('orderCompleted', orderCompletedEvent);
      io.to('production').emit('orderCompleted', orderCompletedEvent);
      io.to(`branch-${order.branch}`).emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
      });
      io.to('admin').emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
      });
      io.to('production').emit('orderStatusUpdated', {
        orderId,
        status: 'completed',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
      });
    } else if (!allTasksCompleted || !allOrderItemsCompleted) {
      console.warn(`[${new Date().toISOString()}] Order ${orderId} not completed yet:`, {
        allTasksCompleted,
        allOrderItemsCompleted,
        incompleteItems: order.items.filter(i => i.status !== 'completed').map(i => ({ id: i._id, status: i.status })),
        incompleteTasks: allAssignments.filter(a => a.status !== 'completed').map(a => ({ id: a._id, status: a.status })),
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
    };
    io.to(`chef-${task.chef}`).emit('taskStatusUpdated', taskStatusUpdatedEvent);
    io.to(`branch-${order.branch}`).emit('taskStatusUpdated', taskStatusUpdatedEvent);
    io.to('admin').emit('taskStatusUpdated', taskStatusUpdatedEvent);
    io.to('production').emit('taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
      };
      io.to(`chef-${task.chef}`).emit('taskCompleted', taskCompletedEvent);
      io.to(`branch-${order.branch}`).emit('taskCompleted', taskCompletedEvent);
      io.to('admin').emit('taskCompleted', taskCompletedEvent);
      io.to('production').emit('taskCompleted', taskCompletedEvent);
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };