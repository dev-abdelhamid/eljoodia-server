const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = new Set(rooms);
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
    eventData: eventDataWithSound,
  });
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId)
      .populate('items.product', 'name department')
      .session(session);
    if (!order) throw new Error(`الطلب ${orderId} غير موجود`);

    const tasks = await ProductionAssignment.find({ order: orderId })
      .populate('product', 'name department')
      .session(session);

    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await emitSocketEvent(io, [
          `branch-${order.branch}`,
          'production',
          'admin',
          `department-${item.product?.department?._id}`,
          'all-departments'
        ], 'itemStatusUpdated', {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: item.product?.name || 'غير معروف',
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${item._id}-item_status_updated`,
        });
      }
    }

    const allItemsCompleted = order.items.every(i => i.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
      });

      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id').lean();

      await createNotification(
        usersToNotify,
        'order_completed_by_chefs',
        'notifications.order_completed_by_chefs',
        {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: order.branch?.name || 'غير معروف',
          eventId: `${orderId}-order_completed_by_chefs`,
        },
        io
      );

      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', {
        orderId,
        status: 'completed',
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: order.branch?.name || 'غير معروف',
        eventId: `${orderId}-order_completed_by_chefs`,
      });
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
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order)
      .populate('items.product')
      .session(session);
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

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department?._id.toString() !== productDoc.department?._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id,
        userId: req.user.id
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
      status: 'pending'
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
      .session(session)
      .lean();

    const taskAssignedEvent = {
      taskId: newAssignment._id,
      orderId: order,
      orderNumber: orderDoc.orderNumber,
      productId: product,
      productName: productDoc.name,
      chefId: chef,
      chefName: chefDoc.username || 'غير معروف',
      quantity,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'غير معروف',
      itemId,
      eventId: `${newAssignment._id}-new_production_assigned_to_chef`,
    };
    await emitSocketEvent(io, [`chef-${chefProfile._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'newProductionAssignedToChef', taskAssignedEvent);

    await createNotification(
      chef,
      'new_production_assigned_to_chef',
      'notifications.new_production_assigned_to_chef',
      taskAssignedEvent,
      io
    );

    await session.commitTransaction();
    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, { error: err.message, userId: req.user.id });
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
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, {
        invalidTasks: tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id
      });
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chefId }).lean();
    if (!chefProfile) {
      console.error(`[${new Date().toISOString()}] Chef profile not found: ${chefId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الشيف غير موجود' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefProfile._id })
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
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`, {
        invalidTasks: tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id
      });
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, { error: err.message, userId: req.user.id });
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

    const task = await ProductionAssignment.findById(taskId)
      .populate('order')
      .populate('product', 'name')
      .populate('chef', 'user')
      .session(session);
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
    if (!chefProfile || task.chef._id.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef._id, user: req.user.id });
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

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    console.log(`[${new Date().toISOString()}] Updated order item ${task.itemId} status to ${status}, User: ${req.user.id}`);

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date()
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'in_production', User: ${req.user.id}`);

      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id').lean();

      await createNotification(
        usersToNotify,
        'order_status_updated',
        'notifications.order_status_updated',
        {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          status: 'in_production',
          eventId: `${orderId}-order_status_updated`,
        },
        io
      );

      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', {
        orderId,
        status: 'in_production',
        user: { id: req.user.id, username: req.user.username },
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
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
      .session(session)
      .lean();

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
      itemId: task.itemId,
      productName: task.product.name,
      chefId: task.chef._id,
      eventId: `${taskId}-task_status_updated`,
    };
    await emitSocketEvent(io, [`chef-${task.chef._id}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
        productName: task.product.name,
        completedAt: new Date().toISOString(),
        chefId: task.chef._id,
        itemId: task.itemId,
        eventId: `${taskId}-order_completed_by_chefs`,
      };
      await emitSocketEvent(io, [`chef-${task.chef._id}`, `branch-${order.branch}`, 'admin', 'production'], 'orderCompletedByChefs', taskCompletedEvent);

      await createNotification(
        task.chef._id,
        'order_completed_by_chefs',
        'notifications.order_completed_by_chefs',
        taskCompletedEvent,
        io
      );

      const allTasksCompleted = await ProductionAssignment.find({ order: orderId }).session(session).lean();
      if (allTasksCompleted.every(t => t.status === 'completed')) {
        await createNotification(
          await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean(),
          'order_completed_by_chefs',
          'notifications.order_completed_by_chefs',
          {
            orderId,
            orderNumber: task.order.orderNumber,
            branchId: order.branch,
            branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'غير معروف',
            eventId: `${orderId}-order_completed_by_chefs`,
          },
          io
        );
      }
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };