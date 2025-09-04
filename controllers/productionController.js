const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { NotificationService } = require('../utils/notifications');

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
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name department', populate: { path: 'department', select: 'name code' } })
      .session(session);
    if (!order) {
      throw new Error(`الطلب ${orderId} غير موجود`);
    }

    const tasks = await ProductionAssignment.find({ order: orderId })
      .populate('product', 'name department')
      .session(session);

    let allItemsCompleted = true;
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item) {
        if (item.status !== task.status) {
          item.status = task.status;
          if (task.status === 'completed') {
            item.completedAt = task.completedAt || new Date();
          }
          await emitSocketEvent(io, [
            `branch-${order.branch?._id}`,
            'production',
            'admin',
            `department-${item.product.department?._id}`,
            'all-departments'
          ], 'itemStatusUpdated', {
            orderId,
            itemId: item._id,
            status: task.status,
            productName: item.product.name,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            branchName: order.branch?.name || 'Unknown',
            eventId: `${item._id}-item_status_updated`,
          });
        }
        if (task.status !== 'completed') {
          allItemsCompleted = false;
        }
      }
    }

    if (allItemsCompleted && order.status !== 'completed') {
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
        await NotificationService.createNotification(
          user._id,
          'order_completed_by_chefs',
          `تم إكمال الطلب ${order.orderNumber} بالكامل`,
          {
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            eventId: `${orderId}-order_completed_by_chefs`,
          },
          io
        );
      }

      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`], 'orderStatusUpdated', {
        orderId,
        status: 'completed',
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
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
      throw new Error('معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة');
    }

    const orderDoc = await Order.findById(order)
      .populate('branch', 'name')
      .session(session);
    if (!orderDoc) {
      throw new Error('الطلب غير موجود');
    }
    if (orderDoc.status !== 'approved') {
      throw new Error('يجب الموافقة على الطلب قبل تعيين المهام');
    }

    const productDoc = await Product.findById(product)
      .populate('department', 'name code')
      .session(session);
    if (!productDoc) {
      throw new Error('المنتج غير موجود');
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef)
      .populate('department', 'name code')
      .session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department?._id.toString() !== productDoc.department?._id.toString()) {
      throw new Error('الشيف غير صالح أو غير متطابق مع قسم المنتج');
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      throw new Error(`العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج`);
    }

    const existingTask = await ProductionAssignment.findOne({ order, itemId }).session(session);
    if (existingTask) {
      throw new Error('المهمة موجودة بالفعل لهذا العنصر');
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
    orderItem.department = productDoc.department?._id;
    orderDoc.markModified('items');
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name department')
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .session(session)
      .lean();

    const taskAssignedEvent = {
      _id: newAssignment._id,
      order: { _id: order, orderNumber: orderDoc.orderNumber },
      product: { _id: product, name: productDoc.name, department: productDoc.department },
      chefId: chef,
      chefName: chefDoc.username || 'غير معروف',
      quantity,
      itemId,
      status: 'pending',
      branchId: orderDoc.branch?._id,
      branchName: orderDoc.branch?.name || 'Unknown',
      eventId: `${itemId}-new_production_assigned_to_chef`,
    };

    await emitSocketEvent(io, [`chef-${chef}`, `branch-${orderDoc.branch?._id}`, 'admin', 'production'], 'newProductionAssignedToChef', taskAssignedEvent);

    await NotificationService.createNotification(
      chef,
      'new_production_assigned_to_chef',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      {
        taskId: newAssignment._id,
        orderId: order,
        orderNumber: orderDoc.orderNumber,
        branchId: orderDoc.branch?._id,
        productId: product,
        productName: productDoc.name,
        quantity,
        eventId: `${itemId}-new_production_assigned_to_chef`,
      },
      io
    );

    await session.commitTransaction();
    res.status(201).json({
      ...populatedAssignment,
      createdAt: new Date(populatedAssignment.createdAt).toISOString(),
    });
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
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, {
        invalidTasks: tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
      });
    }

    res.status(200).json(validTasks.map(task => ({
      ...task,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
    })));
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

    const chefProfile = await mongoose.model('Chef').findOne({ user: chefId }).lean();
    if (!chefProfile) {
      console.error(`[${new Date().toISOString()}] Chef profile not found: ${chefId}`);
      return res.status(404).json({ success: false, message: 'الشيف غير موجود' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefProfile._id })
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
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`, {
        invalidTasks: tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })),
      });
    }

    res.status(200).json(validTasks.map(task => ({
      ...task,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
    })));
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

    const task = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name')
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .session(session);
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
    if (!chefProfile || task.chef._id.toString() !== chefProfile._id.toString()) {
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

    const order = await Order.findById(orderId)
      .populate('branch', 'name')
      .session(session);
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
        await NotificationService.createNotification(
          user._id,
          'order_status_updated',
          `بدأ إنتاج الطلب ${order.orderNumber}`,
          {
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            eventId: `${orderId}-order_status_updated`,
          },
          io
        );
      }

      await emitSocketEvent(io, [`branch-${order.branch?._id}`, 'admin', 'production'], 'orderStatusUpdated', {
        orderId,
        status: 'in_production',
        user: { id: req.user.id, username: req.user.username },
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        eventId: `${orderId}-order_status_updated`,
      });
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name department')
      .populate({ path: 'chef', select: 'user', populate: { path: 'user', select: 'username' } })
      .session(session)
      .lean();

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
      itemId: task.itemId,
      productName: task.product.name,
      eventId: `${taskId}-task_status_updated`,
    };

    await emitSocketEvent(io, [`chef-${task.chef._id}`, `branch-${order.branch?._id}`, 'admin', 'production'], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chefId: task.chef._id,
        itemId: task.itemId,
        productName: task.product.name,
        eventId: `${taskId}-task_completed`,
      };

      await emitSocketEvent(io, [`chef-${task.chef._id}`, `branch-${order.branch?._id}`, 'admin', 'production'], 'taskCompleted', taskCompletedEvent);

      await NotificationService.createNotification(
        task.chef.user,
        'task_completed',
        `تم إكمال مهمة (${task.product.name}) في الطلب ${task.order.orderNumber}`,
        {
          taskId,
          orderId,
          orderNumber: task.order.orderNumber,
          branchId: order.branch?._id,
          productName: task.product.name,
          eventId: `${taskId}-task_completed`,
        },
        io
      );
    }

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      task: {
        ...populatedTask,
        createdAt: new Date(populatedTask.createdAt).toISOString(),
        updatedAt: new Date(populatedTask.updatedAt).toISOString(),
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const deleteTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(taskId)) {
      throw new Error('معرف المهمة غير صالح');
    }

    const task = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .session(session);
    if (!task) {
      throw new Error('المهمة غير موجودة');
    }

    if (req.user.role !== 'admin') {
      throw new Error('غير مخول لحذف المهمة');
    }

    const order = await Order.findById(task.order._id).session(session);
    if (order) {
      const orderItem = order.items.id(task.itemId);
      if (orderItem) {
        orderItem.status = 'pending';
        orderItem.assignedTo = null;
        order.markModified('items');
        await order.save({ session });
      }
    }

    await task.deleteOne({ session });
    await syncOrderTasks(task.order._id, io, session);

    await emitSocketEvent(io, [`branch-${task.order.branch}`, 'admin', 'production'], 'taskDeleted', {
      taskId,
      orderId: task.order._id,
      orderNumber: task.order.orderNumber,
      branchId: task.order.branch,
      eventId: `${taskId}-task_deleted`,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, message: 'تم حذف المهمة بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error deleting task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus, deleteTask };