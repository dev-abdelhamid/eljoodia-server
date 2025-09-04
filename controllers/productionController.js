const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

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

const notifyUsers = async (io, users, type, message, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!isValidObjectId(order) || !isValidObjectId(product) ||
        !isValidObjectId(chef) || !quantity || quantity < 1 ||
        !isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    const orderDoc = await Order.findById(order).session(session);
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

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
      eventId: `${newAssignment._id}-new_production_assigned_to_chef`,
    };
    await emitSocketEvent(io, [`chef-${chefProfile._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'newProductionAssignedToChef', taskAssignedEvent);
    await notifyUsers(
      io,
      [{ _id: chef }],
      'new_production_assigned_to_chef',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch, eventId: `${newAssignment._id}-new_production_assigned_to_chef` }
    );

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
        populate: { path: 'department', select: 'name code' },
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, {
        invalidTasks: tasks
          .filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id,
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
    if (!isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}, User: ${req.user.id}`);
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
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`, {
        invalidTasks: tasks
          .filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id,
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

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid task status: ${status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'حالة المهمة غير صالحة' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').populate('product').populate('chef').session(session);
    if (!task || task.order._id.toString() !== orderId) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Task not found or order mismatch:`, { taskId, orderId, userId: req.user.id });
      return res.status(404).json({ success: false, message: 'المهمة أو الطلب غير موجود' });
    }

    if (req.user.role !== 'chef' || task.chef.user.toString() !== req.user.id) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized task status update:`, { userId: req.user.id, taskChef: task.chef.user.toString() });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة هذه المهمة' });
    }

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'العنصر غير موجود في الطلب' });
    }

    task.status = status;
    if (status === 'in_progress' && !task.startedAt) {
      task.startedAt = new Date().toISOString();
    } else if (status === 'completed' && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    }

    orderItem.status = status;
    if (status === 'in_progress') {
      orderItem.startedAt = new Date().toISOString();
    } else if (status === 'completed') {
      orderItem.completedAt = new Date().toISOString();
    }

    order.markModified('items');
    await task.save({ session });
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    const branchId = populatedTask.order?.branch;
    const branchName = (await mongoose.model('Branch').findById(branchId).select('name').lean())?.name || 'Unknown';

    const taskData = {
      taskId,
      orderId,
      itemId: task.itemId,
      status,
      productName: populatedTask.product?.name || 'Unknown',
      orderNumber: populatedTask.order?.orderNumber || 'Unknown',
      branchId,
      branchName,
      eventId: `${taskId}-item_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`, `chef-${task.chef.user}`], 'itemStatusUpdated', taskData);
    await notifyUsers(
      io,
      await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean(),
      'item_status_updated',
      `تم تحديث حالة العنصر ${populatedTask.product?.name || 'Unknown'} في الطلب ${populatedTask.order?.orderNumber || 'Unknown'} إلى ${status}`,
      { taskId, orderId, orderNumber: populatedTask.order?.orderNumber, branchId, eventId: `${taskId}-item_status_updated` }
    );

    await session.commitTransaction();
    res.status(200).json(populatedTask);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    console.log(`[${new Date().toISOString()}] Syncing order tasks for order ${orderId}`);
    const order = await Order.findById(orderId)
      .populate('items.product')
      .populate('items.assignedTo', 'username')
      .populate('branch', 'name')
      .session(session);

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in syncOrderTasks: ${orderId}`);
      return;
    }

    const tasks = await ProductionAssignment.find({ order: orderId })
      .populate('product', 'name department')
      .populate('chef', 'user')
      .session(session);

    const unassignedItems = order.items.filter(item => item.status === 'pending' && !item.assignedTo);
    if (unassignedItems.length > 0) {
      const missingAssignmentsEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        unassignedItems: unassignedItems.map(item => ({
          itemId: item._id,
          productName: item.product?.name || 'Unknown',
          quantity: item.quantity,
        })),
        eventId: `${orderId}-missing_assignments`,
      };
      await emitSocketEvent(io, ['admin', 'production'], 'missingAssignments', missingAssignmentsEvent);
      console.log(`[${new Date().toISOString()}] Emitted missingAssignments for order ${orderId}:`, { unassignedItems: unassignedItems.length });
    }

    const allItemsCompleted = order.items.every(item => item.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date().toISOString(),
        notes: 'تم إكمال جميع العناصر تلقائيًا بواسطة النظام',
      });
      await order.save({ session });

      const completedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        adjustedTotal: order.adjustedTotal,
        eventId: `${orderId}-order_completed_by_chefs`,
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`], 'orderCompletedByChefs', completedEvent);
      await notifyUsers(
        io,
        await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean(),
        'order_completed_by_chefs',
        `تم إكمال الطلب ${order.orderNumber} بواسطة الشيفات`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch?._id, eventId: `${orderId}-order_completed_by_chefs` }
      );
      console.log(`[${new Date().toISOString()}] Order ${orderId} marked as completed`);
    }

    console.log(`[${new Date().toISOString()}] Synced tasks for order ${orderId}:`, {
      totalTasks: tasks.length,
      unassignedItems: unassignedItems.length,
      orderStatus: order.status,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, { orderId, error: err.message });
    throw err;
  }
};

module.exports = {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
  syncOrderTasks,
};