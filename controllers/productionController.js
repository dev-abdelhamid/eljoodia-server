const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const soundTypeMap = {
    taskAssigned: 'task_assigned',
    taskStatusUpdated: 'task_status_updated',
    taskCompleted: 'task_completed',
    itemStatusUpdated: 'item_status_updated',
    orderStatusUpdated: 'order_status_updated',
    orderCompleted: 'order_completed',
    inventoryUpdated: 'inventory_updated',
  };
  const soundType = soundTypeMap[eventName] || 'notification';
  const eventDataWithSound = {
    ...eventData,
    sound: `https://eljoodia-client.vercel.app/sounds/${soundType}.mp3`,
    vibrate: eventName === 'taskAssigned' ? [400, 100, 400] : [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${eventData.taskId || eventData.orderId || Date.now()}`,
  };

  const uniqueRooms = [...new Set(rooms)].filter(room => room && !room.includes('all-departments'));
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName} to rooms: ${uniqueRooms.join(', ')}`, {
    eventData: eventDataWithSound,
  });
};

const notifyUsers = async (io, users, type, message, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id?.toString() || 'Unknown'),
    message,
    data,
  });
  for (const user of users) {
    try {
      const notification = await createNotification(
        user._id,
        type,
        message,
        { ...data, eventId: `${data.taskId || data.orderId || 'generic'}-${type}-${user._id}` },
        io
      );
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
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
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, {
        order,
        product,
        chef,
        quantity,
        itemId,
        userId: req.user.id,
      });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order).populate('items.product').session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين المهام' });
    }

    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const inventory = await Inventory.findOne({ branch: orderDoc.branch, product }).session(session);
    if (!inventory || inventory.currentStock < quantity) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Insufficient inventory for product: ${product}, Requested: ${quantity}, Available: ${inventory?.currentStock || 0}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'المخزون غير كافٍ للمنتج المطلوب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id,
        userId: req.user.id,
      });
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product, userId: req.user.id });
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity, userId: req.user.id });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending',
    });
    await newAssignment.save({ session });

    inventory.currentStock -= quantity;
    await inventory.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    orderDoc.markModified('items');
    await orderDoc.save({ session });

    await emitSocketEvent(io, [
      `branch-${orderDoc.branch}`,
      'admin',
      'production',
    ], 'inventoryUpdated', {
      branchId: orderDoc.branch,
      productId: product,
      currentStock: inventory.currentStock,
      eventId: `${itemId}-inventory_updated`,
    });

    await syncOrderTasks(order._id, io, session);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .lean();

    const taskAssignedEvent = {
      _id: newAssignment._id,
      type: 'task_assigned',
      orderId: order,
      taskId: newAssignment._id,
      chefId: chefProfile._id,
      productId: product,
      productName: productDoc.name,
      quantity,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
      eventId: `${newAssignment._id}-task_assigned`,
    };
    await emitSocketEvent(io, [
      `user-${chef}`,
      `chef-${chefProfile._id}`,
      `branch-${orderDoc.branch}`,
      'admin',
      'production',
      `department-${productDoc.department._id}`,
    ], 'taskAssigned', taskAssignedEvent);

    await notifyUsers(io, [{ _id: chef }], 'new_production_assigned_to_chef',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { orderId: order, taskId: newAssignment._id, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch, chefId: chef, productId: product, productName: productDoc.name, quantity, eventId: `${newAssignment._id}-task_assigned` }
    );

    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const query = {};
    if (req.user.role === 'branch') query.branch = req.user.branchId;
    if (req.query.status) query.status = req.query.status;

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber _id branch')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, {
        invalidTasks: tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id,
      });
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    const { page = 1, limit = 10, status, search } = req.query;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chefId }).lean();
    if (!chefProfile) {
      console.error(`[${new Date().toISOString()}] Chef profile not found: ${chefId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'ملف الشيف غير موجود' });
    }

    const query = { chef: chefProfile._id };
    if (status) query.status = status;
    if (search) query['order.orderNumber'] = { $regex: search, $options: 'i' };

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber _id branch')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await ProductionAssignment.countDocuments(query);

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`, {
        invalidTasks: tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id,
      });
    }

    res.status(200).json({ tasks: validTasks, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, { error: err.message, stack: err.stack, userId: req.user.id });
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
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId, userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}, User: ${req.user.id}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId, User: ${req.user.id}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
    }
    if (task.order._id.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match order ${orderId}, User: ${req.user.id}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef, chefProfileId: chefProfile?._id });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}, User: ${req.user.id}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed, User: ${req.user.id}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}, User: ${req.user.id}`);

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}, User: ${req.user.id}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    const productDoc = await Product.findById(orderItem.product).select('name department').populate('department').lean();

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    console.log(`[${new Date().toISOString()}] Updated order item ${task.itemId} status to ${status}, User: ${req.user.id}`);

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'in_production', User: ${req.user.id}`);
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_status_updated',
        `بدأ إنتاج الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${orderId}-order_status_updated` }
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: { _id: req.user.id, username: req.user.username },
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        eventId: `${orderId}-order_status_updated`,
      };
      await emitSocketEvent(io, [
        `branch-${order.branch}`,
        'admin',
        'production',
        `user-${req.user.id}`,
        `department-${productDoc.department._id}`,
      ], 'orderStatusUpdated', orderStatusUpdatedEvent);
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    if (status === 'completed' && tasks.every(t => t.status === 'completed') && order.status !== 'completed') {
      order.status = 'completed';
      order.completedAt = new Date();
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'completed', User: ${req.user.id}`);
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم إكمال الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${orderId}-order_completed` }
      );
      const orderCompletedEvent = {
        orderId,
        status: 'completed',
        user: { _id: req.user.id, username: req.user.username },
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        eventId: `${orderId}-order_completed`,
      };
      await emitSocketEvent(io, [
        `branch-${order.branch}`,
        'admin',
        'production',
        `user-${req.user.id}`,
        `department-${productDoc.department._id}`,
      ], 'orderCompleted', orderCompletedEvent);
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
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .lean();

    const taskStatusUpdatedEvent = {
      _id: taskId,
      type: 'task_status_updated',
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      itemId: task.itemId,
      productName: productDoc.name,
      chefId: task.chef._id,
      eventId: `${taskId}-task_status_updated`,
    };
    await emitSocketEvent(io, [
      `user-${req.user.id}`,
      `chef-${task.chef._id}`,
      `branch-${order.branch}`,
      'admin',
      'production',
      `department-${productDoc.department._id}`,
    ], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        _id: taskId,
        type: 'task_completed',
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id, username: task.chef.user?.username || 'Unknown' },
        itemId: task.itemId,
        productName: productDoc.name,
        eventId: `${taskId}-task_completed`,
      };
      await emitSocketEvent(io, [
        `user-${req.user.id}`,
        `chef-${task.chef._id}`,
        `branch-${order.branch}`,
        'admin',
        'production',
        `department-${productDoc.department._id}`,
      ], 'taskCompleted', taskCompletedEvent);
      await notifyUsers(io, [{ _id: task.chef.user._id }], 'task_completed',
        `تم إكمال مهمة (${productDoc.name}) في الطلب ${task.order.orderNumber}`,
        { taskId, orderId, orderNumber: task.order.orderNumber, branchId: order.branch, chefId: task.chef._id, productName: productDoc.name, eventId: `${taskId}-task_completed` }
      );
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order ${orderId} not found in syncOrderTasks`);
      throw new Error(`Order ${orderId} not found`);
    }

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    let itemsModified = false;

    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
          const inventory = await Inventory.findOne({ branch: order.branch, product: item.product }).session(session);
          if (inventory) {
            inventory.currentStock -= task.quantity;
            await inventory.save({ session });
            await emitSocketEvent(io, [
              `branch-${order.branch}`,
              'admin',
              'production',
            ], 'inventoryUpdated', {
              branchId: order.branch,
              productId: item.product,
              currentStock: inventory.currentStock,
              eventId: `${item._id}-inventory_updated`,
            });
          }
        }
        itemsModified = true;
        const productDoc = await Product.findById(item.product).select('name department').populate('department').lean();
        await emitSocketEvent(io, [
          `branch-${order.branch}`,
          'production',
          'admin',
          `department-${productDoc.department?._id || 'unknown'}`,
          ...task.chef ? [`user-${task.chef.user?._id || task.chef}`] : [],
        ], 'itemStatusUpdated', {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: productDoc.name || 'Unknown',
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
          eventId: `${item._id}-item_status_updated`,
        });
      }
    }

    if (itemsModified) {
      order.markModified('items');
      await order.save({ session });
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, { error: err.message, stack: err.stack });
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };