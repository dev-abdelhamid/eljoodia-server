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
  const message = isRtl ? `رسالة عربي لـ ${messageKey}` : `English message for ${messageKey}`;
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb, isRtl);
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
  const isRtl = req.query.isRtl === 'true';
  try {
    session.startTransaction();
    const { order, factoryOrder, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if ((!order && !factoryOrder) || (order && factoryOrder) || !mongoose.isValidObjectId(order || factoryOrder) ||
        !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, factoryOrder, product, chef, quantity, itemId, userId: req.user.id });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب (عادي أو مصنع)، المنتج، الشيف، الكمية، ومعرف العنصر مطلوبة ويجب أن تكون صالحة' : 'Order or factoryOrder, product, chef, quantity, and item ID are required and must be valid',
      });
    }

    const model = order ? Order : FactoryOrder;
    const id = order || factoryOrder;
    const orderDoc = await model.findById(id).session(session).setOptions({ context: { isRtl } });
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] ${order ? 'Order' : 'FactoryOrder'} not found for createTask: ${id}`);
      return res.status(404).json({
        success: false,
        message: isRtl ? `${order ? 'الطلب' : 'طلب المصنع'} غير موجود` : `${order ? 'Order' : 'FactoryOrder'} not found`,
      });
    }
    if (orderDoc.status !== (order ? 'approved' : 'pending')) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] ${order ? 'Order' : 'FactoryOrder'} ${id} not in correct status for task creation`);
      return res.status(400).json({
        success: false,
        message: isRtl ? `يجب أن يكون ${order ? 'الطلب موافق عليه' : 'طلب المصنع معلق'} قبل تعيين المهام` : `${order ? 'Order must be approved' : 'FactoryOrder must be pending'} before assigning tasks`,
      });
    }

    const productDoc = await Product.findById(product).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({
        success: false,
        message: isRtl ? 'المنتج غير موجود' : 'Product not found',
      });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefProfile.department.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id,
        userId: req.user.id,
      });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'الشيف غير صالح أو غير متطابق مع قسم المنتج' : 'Invalid chef or department mismatch',
      });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product, userId: req.user.id });
      return res.status(400).json({
        success: false,
        message: isRtl ? `العنصر ${itemId} غير موجود في ${order ? 'الطلب' : 'طلب المصنع'} أو لا يتطابق مع المنتج` : `Item ${itemId} not found in ${order ? 'order' : 'factoryOrder'} or does not match product`,
      });
    }

    console.log(`[${new Date().toISOString()}] Creating task for ${order ? 'Order' : 'FactoryOrder'}:`, { id, itemId, product, chef, quantity, userId: req.user.id });

    const newAssignment = new ProductionAssignment({
      order: order ? id : undefined,
      factoryOrder: factoryOrder ? id : undefined,
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

    await syncOrderTasks(id, io, session, isRtl, !!factoryOrder);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate(order ? 'order' : 'factoryOrder', 'orderNumber')
      .populate('product', 'name nameEn')
      .populate('chef', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: isRtl ? orderDoc.branch?.name : (orderDoc.branch?.nameEn || orderDoc.branch?.name || 'Unknown'),
      itemId,
      eventId: `${itemId}-taskAssigned`,
      productName: isRtl ? populatedAssignment.product.name : (populatedAssignment.product.nameEn || populatedAssignment.product.name || 'Unknown'),
      chefName: isRtl ? populatedAssignment.chef.name : (populatedAssignment.chef.nameEn || populatedAssignment.chef.name || 'Unknown'),
      orderNumber: populatedAssignment[order ? 'order' : 'factoryOrder']?.orderNumber || 'Unknown',
      isRtl,
    };
    await emitSocketEvent(io, [`chef-${chefDoc._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], order ? 'taskAssigned' : 'factoryTaskAssigned', taskAssignedEvent, isRtl);
    await notifyUsers(io, [{ _id: chefDoc._id }], order ? 'taskAssigned' : 'factoryTaskAssigned',
      isRtl ? `تم تعيينك لإنتاج ${populatedAssignment.product.name} في ${order ? 'الطلب' : 'طلب المصنع'} ${orderDoc.orderNumber}` : 
             `Assigned to produce ${populatedAssignment.product.nameEn || populatedAssignment.product.name} for ${order ? 'order' : 'factoryOrder'} ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: id, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch, eventId: `${itemId}-taskAssigned`, isRtl },
      false, isRtl
    );

    res.status(201).json(taskAssignedEvent);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  try {
    const tasks = await ProductionAssignment.find()
      .populate({
        path: 'order',
        select: 'orderNumber _id branch',
        match: { _id: { $exists: true } },
      })
      .populate({
        path: 'factoryOrder',
        select: 'orderNumber _id branch',
        match: { _id: { $exists: true } },
      })
      .populate({
        path: 'product',
        select: 'name nameEn department',
        populate: { path: 'department', select: 'name nameEn code' },
      })
      .populate('chef', 'username name nameEn')
      .sort({ updatedAt: -1 })
      .setOptions({ context: { isRtl } })
      .lean();

    const validTasks = tasks.filter(task => (task.order || task.factoryOrder) && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`, {
        invalidTasks: tasks.filter(task => !task.order && !task.factoryOrder || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, factoryOrder: t.factoryOrder?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id,
      });
    }

    const formattedTasks = validTasks.map(task => ({
      ...task,
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      departmentName: isRtl ? task.product.department.name : (task.product.department.nameEn || task.product.department.name || 'Unknown'),
      chefName: isRtl ? task.chef.name : (task.chef.nameEn || task.chef.name || 'Unknown'),
      branchName: isRtl ? (task.order?.branch?.name || task.factoryOrder?.branch?.name) : 
                        (task.order?.branch?.nameEn || task.factoryOrder?.branch?.nameEn || task.order?.branch?.name || task.factoryOrder?.branch?.name || 'Unknown'),
      orderNumber: task.order?.orderNumber || task.factoryOrder?.orderNumber || 'Unknown',
      isFactory: !!task.factoryOrder,
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  }
};

const getChefTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`, { userId: req.user.id });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الشيف غير صالح' : 'Invalid chef ID',
      });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate({
        path: 'order',
        select: 'orderNumber _id branch',
        match: { _id: { $exists: true } },
      })
      .populate({
        path: 'factoryOrder',
        select: 'orderNumber _id branch',
        match: { _id: { $exists: true } },
      })
      .populate({
        path: 'product',
        select: 'name nameEn department',
        populate: { path: 'department', select: 'name nameEn code' },
      })
      .populate('chef', 'username name nameEn')
      .sort({ updatedAt: -1 })
      .setOptions({ context: { isRtl } })
      .lean();

    const validTasks = tasks.filter(task => (task.order || task.factoryOrder) && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`, {
        invalidTasks: tasks.filter(task => !task.order && !task.factoryOrder || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, factoryOrder: t.factoryOrder?._id, product: t.product?._id, itemId: t.itemId })),
        userId: req.user.id,
      });
    }

    const formattedTasks = validTasks.map(task => ({
      ...task,
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      departmentName: isRtl ? task.product.department.name : (task.product.department.nameEn || task.product.department.name || 'Unknown'),
      chefName: isRtl ? task.chef.name : (task.chef.nameEn || task.chef.name || 'Unknown'),
      branchName: isRtl ? (task.order?.branch?.name || task.factoryOrder?.branch?.name) : 
                        (task.order?.branch?.nameEn || task.factoryOrder?.branch?.nameEn || task.order?.branch?.name || task.factoryOrder?.branch?.name || 'Unknown'),
      orderNumber: task.order?.orderNumber || task.factoryOrder?.orderNumber || 'Unknown',
      isFactory: !!task.factoryOrder,
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
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
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId, userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب أو المهمة غير صالح' : 'Invalid order or task ID',
      });
    }

    const task = await ProductionAssignment.findById(taskId)
      .populate('order')
      .populate('factoryOrder')
      .populate('chef')
      .populate('product', 'name nameEn')
      .session(session)
      .setOptions({ context: { isRtl } });
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`, { userId: req.user.id });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'المهمة غير موجودة' : 'Task not found',
      });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`, { userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف العنصر مفقود في المهمة' : 'Item ID missing in task',
      });
    }
    const isFactory = !!task.factoryOrder;
    const model = isFactory ? FactoryOrder : Order;
    const id = isFactory ? task.factoryOrder?._id : task.order?._id;
    if (id?.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match ${isFactory ? 'factoryOrder' : 'order'} ${orderId}`, { userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? `المهمة لا تتطابق مع ${isFactory ? 'طلب المصنع' : 'الطلب'}` : `Task does not match ${isFactory ? 'factoryOrder' : 'order'}`,
      });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef._id.toString() !== chefProfile.user.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef._id, userRole: req.user.role });
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لتحديث هذه المهمة' : 'Unauthorized to update this task',
      });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`, { userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'حالة غير صالحة' : 'Invalid status',
      });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed`, { userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'المهمة مكتملة بالفعل' : 'Task already completed',
      });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}`, { userId: req.user.id });

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await model.findById(orderId).session(session).setOptions({ context: { isRtl } });
    if (!order) {
      console.error(`[${new Date().toISOString()}] ${isFactory ? 'FactoryOrder' : 'Order'} not found: ${orderId}`, { userId: req.user.id });
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? `${isFactory ? 'طلب المصنع' : 'الطلب'} غير موجود` : `${isFactory ? 'FactoryOrder' : 'Order'} not found`,
      });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`, { userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? `العنصر ${task.itemId} غير موجود في ${isFactory ? 'طلب المصنع' : 'الطلب'}` : `Item ${task.itemId} not found in ${isFactory ? 'factoryOrder' : 'order'}`,
      });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    console.log(`[${new Date().toISOString()}] Updated order item ${task.itemId} status to ${status}`, { userId: req.user.id });

    if (status === 'in_progress' && order.status === (isFactory ? 'pending' : 'approved')) {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: isRtl ? 'بدأ الإنتاج' : 'Production started',
        notesEn: 'Production started',
      });
      console.log(`[${new Date().toISOString()}] Updated ${isFactory ? 'factoryOrder' : 'order'} ${orderId} status to 'in_production'`, { userId: req.user.id });
      const usersToNotify = await User.find({ role: { $in: ['chef', 'admin', 'production'] } }).select('_id').lean();
      await notifyUsers(io, usersToNotify, isFactory ? 'factoryOrderStatusUpdated' : 'orderStatusUpdated',
        isRtl ? `بدأ إنتاج ${isFactory ? 'طلب المصنع' : 'الطلب'} ${order.orderNumber}` : `Production started for ${isFactory ? 'factoryOrder' : 'order'} ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${orderId}-orderStatusUpdated-in_production`, isRtl },
        false, isRtl
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
        eventId: `${orderId}-orderStatusUpdated-in_production`,
        isRtl,
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], isFactory ? 'factoryOrderStatusUpdated' : 'orderStatusUpdated', orderStatusUpdatedEvent, isRtl);
    }

    if (order.items.every(i => i.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: isRtl ? 'جميع العناصر مكتملة' : 'All items completed',
        notesEn: 'All items completed',
      });
      console.log(`[${new Date().toISOString()}] Updated ${isFactory ? 'factoryOrder' : 'order'} ${orderId} status to 'completed'`, { userId: req.user.id });
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'branch', 'chef'] }, branch: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, isFactory ? 'factoryOrderCompleted' : 'orderCompleted',
        isRtl ? `تم إكمال ${isFactory ? 'طلب المصنع' : 'الطلب'} ${order.orderNumber}` : `${isFactory ? 'FactoryOrder' : 'Order'} ${order.orderNumber} completed`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, status: 'completed', eventId: `${orderId}-orderCompleted`, isRtl },
        true, isRtl
      );
      const orderCompletedEvent = {
        orderId,
        status: 'completed',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
        eventId: `${orderId}-orderCompleted`,
        isRtl,
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], isFactory ? 'factoryOrderCompleted' : 'orderCompleted', orderCompletedEvent, isRtl);
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session, isRtl, isFactory);

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate(isFactory ? 'factoryOrder' : 'order', 'orderNumber branch')
      .populate('product', 'name nameEn')
      .populate('chef', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const formattedTask = {
      ...populatedTask,
      productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
      chefName: isRtl ? populatedTask.chef.name : (populatedTask.chef.nameEn || poppedTask.chef.name || 'Unknown'),
      branchName: isRtl ? (populatedTask.order?.branch?.name || populatedTask.factoryOrder?.branch?.name) : 
                        (populatedTask.order?.branch?.nameEn || populatedTask.factoryOrder?.branch?.nameEn || 
                         populatedTask.order?.branch?.name || populatedTask.factoryOrder?.branch?.name || 'Unknown'),
      orderNumber: populatedTask.order?.orderNumber || populatedTask.factoryOrder?.orderNumber || 'Unknown',
      isFactory,
      isRtl,
    };

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: populatedTask.order?.orderNumber || populatedTask.factoryOrder?.orderNumber || 'Unknown',
      branchId: order.branch,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
      itemId: task.itemId,
      productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
      eventId: `${taskId}-taskStatusUpdated-${status}`,
      isRtl,
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], isFactory ? 'factoryItemStatusUpdated' : 'itemStatusUpdated', taskStatusUpdatedEvent, isRtl);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: populatedTask.order?.orderNumber || populatedTask.factoryOrder?.orderNumber || 'Unknown',
        branchId: order.branch,
        branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
        productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
        eventId: `${taskId}-taskCompleted`,
        isRtl,
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], isFactory ? 'factoryTaskCompleted' : 'taskCompleted', taskCompletedEvent, isRtl);
      await notifyUsers(io, [{ _id: task.chef._id }], isFactory ? 'factoryTaskCompleted' : 'taskCompleted',
        isRtl ? `تم إكمال مهمة لـ ${isFactory ? 'طلب المصنع' : 'الطلب'} ${populatedTask.order?.orderNumber || populatedTask.factoryOrder?.orderNumber}` : 
               `Task completed for ${isFactory ? 'factoryOrder' : 'order'} ${populatedTask.order?.orderNumber || populatedTask.factoryOrder?.orderNumber}`,
        { taskId, orderId, orderNumber: populatedTask.order?.orderNumber || populatedTask.factoryOrder?.orderNumber, branchId: order.branch, eventId: `${taskId}-taskCompleted`, isRtl },
        false, isRtl
      );
    }

    res.status(200).json({ success: true, task: formattedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session, isRtl, isFactory = false) => {
  try {
    const model = isFactory ? FactoryOrder : Order;
    const order = await model.findById(orderId).session(session).setOptions({ context: { isRtl } });
    if (!order) {
      console.error(`[${new Date().toISOString()}] ${isFactory ? 'FactoryOrder' : 'Order'} not found: ${orderId}`);
      throw new Error(isRtl ? `${isFactory ? 'طلب المصنع' : 'الطلب'} ${orderId} غير موجود` : `${isFactory ? 'FactoryOrder' : 'Order'} ${orderId} not found`);
    }

    const tasks = await ProductionAssignment.find({ [isFactory ? 'factoryOrder' : 'order']: orderId })
      .session(session)
      .setOptions({ context: { isRtl } })
      .lean();
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await emitSocketEvent(io, [
          'admin',
          'production',
          `department-${item.product.department?._id}`,
          `branch-${order.branch}`,
          `chef-${task.chef}`,
          'all-departments'
        ], isFactory ? 'factoryItemStatusUpdated' : 'itemStatusUpdated', {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name || 'Unknown'),
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
          sound: 'https://eljoodia-client.vercel.app/sounds/status-updated.mp3',
          vibrate: [200, 100, 200],
          eventId: `${task._id}-itemStatusUpdated-${task.status}`,
          isRtl,
        }, isRtl);
      }
    }
    if (order.items.every(i => i.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
        notes: isRtl ? 'جميع العناصر مكتملة عبر المزامنة' : 'All items completed via sync',
        notesEn: 'All items completed via sync',
      });
      await order.save({ session });
      await emitSocketEvent(io, [
        'admin',
        'production',
        `branch-${order.branch}`,
        'all-departments'
      ], isFactory ? 'factoryOrderCompleted' : 'orderCompleted', {
        orderId,
        status: 'completed',
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
        eventId: `${orderId}-orderCompleted`,
        isRtl,
      }, isRtl);
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'branch', 'chef'] }, branch: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, isFactory ? 'factoryOrderCompleted' : 'orderCompleted',
        isRtl ? `تم إكمال ${isFactory ? 'طلب المصنع' : 'الطلب'} ${order.orderNumber}` : `${isFactory ? 'FactoryOrder' : 'Order'} ${order.orderNumber} completed`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, status: 'completed', eventId: `${orderId}-orderCompleted`, isRtl },
        true, isRtl
      );
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing ${isFactory ? 'factoryOrder' : 'order'} tasks:`, {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };