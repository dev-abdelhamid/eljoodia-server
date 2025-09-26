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
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

const notifyUsers = async (io, users, type, message, data, saveToDb = false, lang = 'ar') => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, { users: users.map(u => u._id), message, data });
  for (const user of users) {
    try {
      await createNotification(user._id, type, lang === 'ar' ? message.ar : message.en, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err);
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const lang = req.query.lang || 'ar';
    const io = req.app.get('io');

    if (!isValidObjectId(order) || !isValidObjectId(product) ||
        !isValidObjectId(chef) || !quantity || quantity < 1 ||
        !isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' : 'Valid order, product, chef, quantity, and itemId are required' 
      });
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ 
        success: false, 
        message: lang === 'ar' ? 'الطلب غير موجود' : 'Order not found' 
      });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'يجب الموافقة على الطلب قبل تعيين المهام' : 'Order must be approved before assigning tasks' 
      });
    }

    const productDoc = await Product.findById(product)
      .populate('department')
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .session(session);
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ 
        success: false, 
        message: lang === 'ar' ? 'المنتج غير موجود' : 'Product not found' 
      });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefProfile.department.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id
      });
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'الشيف غير صالح أو غير متطابق مع قسم المنتج' : 'Invalid chef or department mismatch' 
      });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` : `Item ${itemId} not found in order or does not match product` 
      });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefDoc._id,
      quantity,
      itemId,
      status: 'pending'
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chefDoc._id;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name nameEn')
      .populate('chef', 'username name')
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const branchDoc = await mongoose.model('Branch').findById(orderDoc.branch)
      .select('name nameEn')
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const taskAssignedEvent = {
      _id: `${order}-${itemId}-taskAssigned-${Date.now()}`,
      type: 'taskAssigned',
      message: {
        ar: `تم تعيين مهمة لإنتاج ${productDoc.displayName} في الطلب ${orderDoc.orderNumber}`,
        en: `Task assigned to produce ${productDoc.displayName} in order ${orderDoc.orderNumber}`
      },
      data: {
        orderId: order,
        orderNumber: orderDoc.orderNumber,
        taskId: newAssignment._id,
        branchId: orderDoc.branch,
        branchName: branchDoc?.displayName || 'غير معروف',
        productId: product,
        productName: productDoc.displayName,
        quantity,
        chefId: chef,
        eventId: `${newAssignment._id}-task_assigned`
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: orderDoc.branch }).select('_id').lean();

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers, { _id: chef }],
      'taskAssigned',
      taskAssignedEvent.message,
      taskAssignedEvent.data,
      false,
      lang
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${orderDoc.branch}`, `chef-${chef}`], 'taskAssigned', taskAssignedEvent);

    await session.commitTransaction();
    res.status(201).json({
      ...populatedAssignment,
      createdAt: new Date(populatedAssignment.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const { status, branch, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query['order.branch'] = branch;
    if (req.user.role === 'branch') query['order.branch'] = req.user.branchId;

    console.log(`[${new Date().toISOString()}] Fetching tasks with query:`, { query, userId: req.user.id, role: req.user.role });

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name nameEn price unit unitEn')
      .populate('chef', 'username name')
      .populate({ path: 'order.branch', select: 'name nameEn city cityEn' })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const total = await ProductionAssignment.countDocuments(query);

    const formattedTasks = tasks.map(task => ({
      ...task,
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
      productName: task.product?.displayName || task.product?.name || 'N/A',
      branchName: task.order?.branch?.displayName || task.order?.branch?.name || 'N/A',
    }));

    res.status(200).json({ tasks: formattedTasks, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    const { status, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';

    if (!isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chef ID: ${chefId}, User: ${req.user.id}`);
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'معرف الشيف غير صالح' : 'Invalid chef ID' 
      });
    }

    const query = { chef: chefId };
    if (status) query.status = status;

    console.log(`[${new Date().toISOString()}] Fetching chef tasks with query:`, { query, userId: req.user.id });

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name nameEn price unit unitEn')
      .populate('chef', 'username name')
      .populate({ path: 'order.branch', select: 'name nameEn city cityEn' })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const total = await ProductionAssignment.countDocuments(query);

    const formattedTasks = tasks.map(task => ({
      ...task,
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
      productName: task.product?.displayName || task.product?.name || 'N/A',
      branchName: task.order?.branch?.displayName || task.order?.branch?.name || 'N/A',
    }));

    res.status(200).json({ tasks: formattedTasks, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, taskId } = req.params;
    const { status } = req.body;
    const lang = req.query.lang || 'ar';
    const io = req.app.get('io');

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order or task ID:`, { orderId, taskId, userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'معرف الطلب أو المهمة غير صالح' : 'Invalid order or task ID' 
      });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid task status: ${status}, User: ${req.user.id}`);
      return res.status(400).json({ 
        success: false, 
        message: lang === 'ar' ? 'حالة المهمة غير صالحة' : 'Invalid task status' 
      });
    }

    const task = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch status')
      .populate('product', 'name nameEn')
      .session(session);
    if (!task || task.order._id.toString() !== orderId) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Task or order not found:`, { taskId, orderId, userId: req.user.id });
      return res.status(404).json({ 
        success: false, 
        message: lang === 'ar' ? 'المهمة أو الطلب غير موجود' : 'Task or order not found' 
      });
    }

    if (req.user.role !== 'chef' || task.chef.toString() !== req.user.id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
      return res.status(403).json({ 
        success: false, 
        message: lang === 'ar' ? 'غير مخول لتحديث هذه المهمة' : 'Unauthorized to update this task' 
      });
    }

    task.status = status;
    if (status === 'in_progress' && !task.startedAt) task.startedAt = new Date();
    if (status === 'completed' && !task.completedAt) task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    const orderItem = order.items.id(task.itemId);
    if (orderItem) {
      orderItem.status = status === 'completed' ? 'completed' : 'assigned';
      order.markModified('items');
      await order.save({ session });
    }

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name nameEn')
      .populate('chef', 'username name')
      .populate({ path: 'order.branch', select: 'name nameEn city cityEn' })
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const branchDoc = await mongoose.model('Branch').findById(task.order.branch)
      .select('name nameEn')
      .setOptions({ context: { isRtl: lang === 'ar' } })
      .lean();

    const taskEvent = {
      _id: `${orderId}-${taskId}-taskStatusUpdated-${Date.now()}`,
      type: status === 'completed' ? 'taskCompleted' : 'taskStarted',
      message: {
        ar: status === 'completed' 
          ? `تم إكمال مهمة ${populatedTask.product?.displayName} في الطلب ${populatedTask.order.orderNumber}`
          : `بدأت مهمة ${populatedTask.product?.displayName} في الطلب ${populatedTask.order.orderNumber}`,
        en: status === 'completed' 
          ? `Task ${populatedTask.product?.displayName} completed in order ${populatedTask.order.orderNumber}`
          : `Task ${populatedTask.product?.displayName} started in order ${populatedTask.order.orderNumber}`
      },
      data: {
        orderId,
        orderNumber: populatedTask.order.orderNumber,
        taskId,
        branchId: populatedTask.order.branch,
        branchName: branchDoc?.displayName || 'N/A',
        productId: task.product,
        productName: populatedTask.product?.displayName || 'N/A',
        chefId: task.chef,
        quantity: task.quantity,
        eventId: `${taskId}-task_${status}`
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: task.order.branch }).select('_id').lean();

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers, { _id: task.chef }],
      taskEvent.type,
      taskEvent.message,
      taskEvent.data,
      status === 'completed',
      lang
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${task.order.branch}`, `chef-${task.chef}`], taskEvent.type, taskEvent);

    if (status === 'completed') {
      const allTasks = await ProductionAssignment.find({ order: orderId }).session(session).lean();
      const isOrderCompleted = allTasks.every(t => t.status === 'completed');
      if (isOrderCompleted) {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: req.user.id,
          changedAt: new Date(),
          notes: lang === 'ar' ? 'تم إكمال جميع المهام' : 'All tasks completed'
        });
        await order.save({ session });

        const orderCompletedEvent = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: {
            ar: `تم إكمال الطلب ${order.orderNumber} بالكامل`,
            en: `Order ${order.orderNumber} fully completed`
          },
          data: {
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch,
            branchName: branchDoc?.displayName || 'N/A',
            eventId: `${orderId}-order_completed`
          },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        await notifyUsers(
          io,
          [...adminUsers, ...productionUsers, ...branchUsers],
          'orderCompleted',
          orderCompletedEvent.message,
          orderCompletedEvent.data,
          true,
          lang
        );

        await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompleted', orderCompletedEvent);
      }
    }

    await session.commitTransaction();
    res.status(200).json({
      ...populatedTask,
      createdAt: new Date(populatedTask.createdAt).toISOString(),
      startedAt: populatedTask.startedAt ? new Date(populatedTask.startedAt).toISOString() : null,
      completedAt: populatedTask.completedAt ? new Date(populatedTask.completedAt).toISOString() : null,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) return;

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session).lean();
    const allTasksCompleted = tasks.every(task => task.status === 'completed');

    if (allTasksCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
        notes: 'تم إكمال جميع المهام تلقائيًا'
      });
      await order.save({ session });

      const branchDoc = await mongoose.model('Branch').findById(order.branch)
        .select('name nameEn')
        .setOptions({ context: { isRtl: true } })
        .lean();

      const orderCompletedEvent = {
        _id: `${orderId}-orderCompleted-${Date.now()}`,
        type: 'orderCompleted',
        message: {
          ar: `تم إكمال الطلب ${order.orderNumber} بالكامل`,
          en: `Order ${order.orderNumber} fully completed`
        },
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: branchDoc?.displayName || 'N/A',
          eventId: `${orderId}-order_completed`
        },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();

      await notifyUsers(
        io,
        [...adminUsers, ...productionUsers, ...branchUsers],
        'orderCompleted',
        orderCompletedEvent.message,
        orderCompletedEvent.data,
        true,
        'ar'
      );

      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompleted', orderCompletedEvent);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, {
      error: err.message,
      orderId,
      stack: err.stack,
    });
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };