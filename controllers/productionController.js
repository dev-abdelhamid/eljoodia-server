const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const FactoryOrder = require('../models/FactoryOrder');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData, isRtl) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
    isRtl,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

const notifyUsers = async (io, users, type, messageKey, data, saveToDb = false, isRtl) => {
  const message = isRtl ? `رسالة عربي لـ ${messageKey}` : `English message for ${messageKey}`; // Replace with actual translation logic
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err);
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  const isRtl = req.query.isRtl === 'true';
  try {
    session.startTransaction();
    const { order, factoryOrder, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if ((!order && !factoryOrder) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 || !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, factoryOrder, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: isRtl ? 'بيانات غير صالحة' : 'Invalid input' });
    }

    let orderDoc;
    let type;
    if (order) {
      orderDoc = await Order.findById(order).session(session).setOptions({ context: { isRtl } });
      type = 'order';
    } else {
      orderDoc = await FactoryOrder.findById(factoryOrder).session(session).setOptions({ context: { isRtl } });
      type = 'factoryOrder';
    }
    if (!orderDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب الموافقة على الطلب قبل تعيين المهام' : 'Order must be approved before assigning tasks' });
    }

    const productDoc = await Product.findById(product).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!productDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }

    const chefDoc = await User.findById(chef).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!chefDoc || chefDoc.role !== 'chef' || chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الشيف غير صالح أو غير متطابق مع قسم المنتج' : 'Invalid chef or department mismatch' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'العنصر غير موجود أو لا يتطابق مع المنتج' : 'Item not found or does not match product' });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order || factoryOrder, itemId, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order: order || undefined,
      factoryOrder: factoryOrder || undefined,
      product: product,
      chef: chef,
      quantity: quantity,
      itemId: itemId,
      status: 'pending'
    });
    await newAssignment.save({ session: session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session: session });

    await syncOrderTasks(orderDoc._id, io, session, isRtl, type);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate(type === 'order' ? 'order' : 'factoryOrder', 'orderNumber')
      .populate('product', 'name nameEn')
      .populate('chef', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: type === 'order' ? populatedAssignment.order.branch : undefined,
      branchName: type === 'order' ? (isRtl ? populatedAssignment.order.branch.name : populatedAssignment.order.branch.nameEn || populatedAssignment.order.branch.name || 'Unknown') : undefined,
      itemId,
      eventId: `${itemId}-taskAssigned`,
      productName: isRtl ? populatedAssignment.product.name : (populatedAssignment.product.nameEn || populatedAssignment.product.name || 'Unknown'),
      chefName: isRtl ? populatedAssignment.chef.name : (populatedAssignment.chef.nameEn || populatedAssignment.chef.name || 'Unknown'),
      isRtl,
    };
    await emitSocketEvent(io, [`chef-${chefDoc._id}`, 'admin', 'production', type === 'order' ? `branch-${orderDoc.branch}` : ''], 'taskAssigned', taskAssignedEvent, isRtl);
    await notifyUsers(io, [{ _id: chefDoc._id }], 'taskAssigned',
      isRtl ? `تم تعيينك لإنتاج ${populatedAssignment.product.name} في الطلب ${orderDoc.orderNumber}` : `Assigned to produce ${populatedAssignment.product.nameEn || populatedAssignment.product.name} for order ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: orderDoc._id, orderNumber: orderDoc.orderNumber, branchId: type === 'order' ? orderDoc.branch : undefined, eventId: `${itemId}-taskAssigned`, isRtl },
      false, isRtl
    );

    res.status(201).json(taskAssignedEvent);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber branch')
      .populate('factoryOrder', 'orderNumber')
      .populate('product', 'name nameEn department')
      .populate('chef', 'username name nameEn')
      .sort({ updatedAt: -1 })
      .setOptions({ context: { isRtl } })
      .lean();

    const validTasks = tasks.filter(task => (task.order || task.factoryOrder) && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`,
        tasks.filter(task => !task.order && !task.factoryOrder || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, factoryOrder: t.factoryOrder?._id, product: t.product?._id, itemId: t.itemId })));
    }

    const formattedTasks = validTasks.map(task => ({
      ...task,
      orderType: task.order ? 'branch' : 'factory',
      orderNumber: task.order ? task.order.orderNumber : task.factoryOrder ? task.factoryOrder.orderNumber : 'Unknown',
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      departmentName: isRtl ? task.product.department.name : (task.product.department.nameEn || task.product.department.name || 'Unknown'),
      chefName: isRtl ? task.chef.name : (task.chef.nameEn || task.chef.name || 'Unknown'),
      branchName: task.order ? (isRtl ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name || 'Unknown')) : undefined,
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الشيف غير صالح' : 'Invalid chef ID' });
    }
    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber branch')
      .populate('factoryOrder', 'orderNumber')
      .populate('product', 'name nameEn department')
      .populate('chef', 'username name nameEn')
      .sort({ updatedAt: -1 })
      .setOptions({ context: { isRtl } })
      .lean();

    const validTasks = tasks.filter(task => (task.order || task.factoryOrder) && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`,
        tasks.filter(task => !task.order && !task.factoryOrder || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, factoryOrder: t.factoryOrder?._id, product: t.product?._id, itemId: t.itemId })));
    }

    const formattedTasks = validTasks.map(task => ({
      ...task,
      orderType: task.order ? 'branch' : 'factory',
      orderNumber: task.order ? task.order.orderNumber : task.factoryOrder ? task.factoryOrder.orderNumber : 'Unknown',
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      departmentName: isRtl ? task.product.department.name : (task.product.department.nameEn || task.product.department.name || 'Unknown'),
      chefName: isRtl ? task.chef.name : (task.chef.nameEn || task.chef.name || 'Unknown'),
      branchName: task.order ? (isRtl ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name || 'Unknown')) : undefined,
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const isRtl = req.query.isRtl === 'true';
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو المهمة غير صالح' : 'Invalid order or task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).session(session).setOptions({ context: { isRtl } });
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المهمة غير موجودة' : 'Task not found' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف العنصر مفقود في المهمة' : 'Item ID missing in task' });
    }

    let orderDoc;
    let type;
    if (task.order) {
      orderDoc = await Order.findById(task.order).session(session).setOptions({ context: { isRtl } });
      type = 'order';
    } else if (task.factoryOrder) {
      orderDoc = await FactoryOrder.findById(task.factoryOrder).session(session).setOptions({ context: { isRtl } });
      type = 'factoryOrder';
    } else {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'نوع الطلب غير مدعوم' : 'Unsupported order type' });
    }
    if (!orderDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    const chefDoc = await User.findById(req.user.id).session(session).setOptions({ context: { isRtl } });
    if (!chefDoc || chefDoc.role !== 'chef' || task.chef.toString() !== req.user.id) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث هذه المهمة' : 'Unauthorized to update this task' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة غير صالحة' : 'Invalid status' });
    }
    if (task.status === 'completed' && status === 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'المهمة مكتملة بالفعل' : 'Task already completed' });
    }

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const orderItem = orderDoc.items.id(task.itemId);
    if (!orderItem) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'العنصر غير موجود في الطلب' : 'Item not found in order' });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();

    if (status === 'in_progress' && orderDoc.status === 'approved') {
      orderDoc.status = 'in_production';
      orderDoc.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: isRtl ? 'بدأ الإنتاج' : 'Production started',
      });
      const usersToNotify = await User.find({ role: { $in: ['chef', 'admin', 'production'] } }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'orderStatusUpdated',
        isRtl ? `بدأ إنتاج الطلب ${orderDoc.orderNumber}` : `Production started for order ${orderDoc.orderNumber}`,
        { orderId: orderDoc._id, orderNumber: orderDoc.orderNumber, eventId: `${orderDoc._id}-orderStatusUpdated-in_production`, isRtl },
        false, isRtl
      );
      const orderStatusUpdatedEvent = {
        orderId: orderDoc._id,
        status: 'in_production',
        user: req.user,
        orderNumber: orderDoc.orderNumber,
        eventId: `${orderDoc._id}-orderStatusUpdated-in_production`,
        isRtl,
      };
      await emitSocketEvent(io, ['admin', 'production'], 'orderStatusUpdated', orderStatusUpdatedEvent, isRtl);
    }

    if (orderDoc.items.every(i => i.status === 'completed') && orderDoc.status === 'in_production') {
      orderDoc.status = 'completed';
      orderDoc.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: isRtl ? 'جميع العناصر مكتملة' : 'All items completed',
      });
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'chef'] } }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'orderCompleted',
        isRtl ? `تم إكمال الطلب ${orderDoc.orderNumber}` : `Order ${orderDoc.orderNumber} completed`,
        { orderId: orderDoc._id, orderNumber: orderDoc.orderNumber, eventId: `${orderDoc._id}-orderCompleted`, isRtl },
        false, isRtl
      );
      const orderCompletedEvent = {
        orderId: orderDoc._id,
        status: 'completed',
        user: req.user,
        orderNumber: orderDoc.orderNumber,
        eventId: `${orderDoc._id}-orderCompleted`,
        isRtl,
      };
      await emitSocketEvent(io, ['admin', 'production'], 'orderCompleted', orderCompletedEvent, isRtl);
    }

    orderDoc.markModified('items');
    await orderDoc.save({ session });

    await syncOrderTasks(orderDoc._id, io, session, isRtl, type ? type : '');

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate(type === 'order' ? 'order' : 'factoryOrder', 'orderNumber')
      .populate('product', 'name nameEn')
      .populate('chef', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const formattedTask = {
      ...populatedTask,
      productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
      chefName: isRtl ? populatedTask.chef.name : (populatedTask.chef.nameEn || populatedTask.chef.name || 'Unknown'),
      isRtl,
    };

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: populatedTask[type === 'order' ? 'order' : 'factoryOrder'].orderNumber,
      itemId: task.itemId,
      productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
      eventId: `${taskId}-taskStatusUpdated-${status}`,
      isRtl,
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production'], 'itemStatusUpdated', taskStatusUpdatedEvent, isRtl);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: populatedTask[type === 'order' ? 'order' : 'factoryOrder'].orderNumber,
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef },
        itemId: task.itemId,
        productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
        eventId: `${taskId}-taskCompleted`,
        isRtl,
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production'], 'taskCompleted', taskCompletedEvent, isRtl);
      await notifyUsers(io, [{ _id: task.chef }], 'taskCompleted',
        isRtl ? `تم إكمال مهمة للطلب ${populatedTask[type === 'order' ? 'order' : 'factoryOrder'].orderNumber}` : `Task completed for order ${populatedTask[type === 'order' ? 'order' : 'factoryOrder'].orderNumber}`,
        { taskId, orderId, orderNumber: populatedTask[type === 'order' ? 'order' : 'factoryOrder'].orderNumber, eventId: `${taskId}-taskCompleted`, isRtl },
        false, isRtl
      );
    }

    res.status(200).json({ success: true, task: formattedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (id, io, session, isRtl, type) => {
  try {
    let order;
    if (type === 'order') {
      order = await Order.findById(id).session(session).setOptions({ context: { isRtl } });
    } else if (type === 'factoryOrder') {
      order = await FactoryOrder.findById(id).session(session).setOptions({ context: { isRtl } });
    }
    if (!order) throw new Error(isRtl ? `الطلب ${id} غير موجود` : `Order ${id} not found`);

    const tasks = await ProductionAssignment.find({ [type]: id }).session(session).setOptions({ context: { isRtl } }).lean();
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        const eventData = {
          orderId: id,
          itemId: item._id,
          status: task.status,
          productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name || 'Unknown'),
          orderNumber: order.orderNumber,
          eventId: `${task._id}-itemStatusUpdated-${task.status}`,
          isRtl,
        };
        await emitSocketEvent(io, ['admin', 'production', `chef-${task.chef}`], 'itemStatusUpdated', eventData, isRtl);
      }
    }
    if (order.items.every(i => i.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
        notes: isRtl ? 'جميع العناصر مكتملة عبر المزامنة' : 'All items completed via sync',
      });
      await order.save({ session });
      const eventData = {
        orderId: id,
        status: 'completed',
        orderNumber: order.orderNumber,
        eventId: `${id}-orderCompleted`,
        isRtl,
      };
      await emitSocketEvent(io, ['admin', 'production'], 'orderCompleted', eventData, isRtl);
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'chef'] } }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'orderCompleted',
        isRtl ? `تم إكمال الطلب ${order.orderNumber}` : `Order ${order.orderNumber} completed`,
        { orderId: id, orderNumber: order.orderNumber, eventId: `${id}-orderCompleted`, isRtl },
        false, isRtl
      );
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, updateTaskStatus, syncOrderTasks };