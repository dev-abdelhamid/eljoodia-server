const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const ProductionAssignment = require('../models/ProductionAssignment');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');
const { createReturn, approveReturn } = require('./returnController');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
};

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
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: uniqueRooms,
    eventData: eventDataWithSound,
  });
};

const notifyUsers = async (io, users, type, messageKey, params, data, saveToDb = true) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    params,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, { ...params, ...data }, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const checkOrderExists = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderNumber, items, status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing orderNumber or items:`, { orderNumber, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة' });
    }

    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product)) {
        throw new Error(`معرف المنتج غير صالح: ${item.product}`);
      }
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) existing.quantity += item.quantity;
      else acc.push({ ...item, status: 'pending', startedAt: null, completedAt: null });
      return acc;
    }, []);

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending',
      })),
      status,
      notes: notes?.trim(),
      priority,
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      statusHistory: [{ status, changedBy: req.user.id, changedAt: new Date() }],
    });

    await newOrder.save({ session });
    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean();

    const eventId = `${newOrder._id}-orderCreated`;
    const eventData = {
      orderId: newOrder._id,
      orderNumber,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      eventId,
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'orderCreated',
      'notifications.order_created',
      { orderNumber, branchName: populatedOrder.branch?.name || 'غير معروف' },
      eventData,
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'orderCreated', {
      ...eventData,
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });

    await session.commitTransaction();
    res.status(201).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch, priority } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (priority) query.priority = priority;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    console.log(`[${new Date().toISOString()}] Fetching orders with query:`, { query, userId: req.user.id, role: req.user.role });

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`[${new Date().toISOString()}] Found ${orders.length} orders`);

    const formattedOrders = orders.map(order => ({
      ...order,
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      items: order.items.map(item => ({
        ...item,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
    }));

    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    console.log(`[${new Date().toISOString()}] Fetching order by ID: ${id}, User: ${req.user.id}`);

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch?._id,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const formattedOrder = {
      ...order,
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      items: order.items.map(item => ({
        ...item,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
    };

    console.log(`[${new Date().toISOString()}] Order fetched successfully: ${id}`);
    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID or items:`, { orderId, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch', 'name')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch?._id,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status: ${order.status}, Order: ${orderId}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' });
    }

    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));

    const io = req.app.get('io');
    const assignments = [];
    const chefNotifications = [];

    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error(`معرفات غير صالحة: ${itemId}, ${item.assignedTo}`);
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(`العنصر ${itemId} غير موجود`);
      }

      const existingTask = await ProductionAssignment.findOne({ order: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        throw new Error('لا يمكن إعادة تعيين المهمة لشيف آخر');
      }

      const chef = chefMap.get(item.assignedTo);
      const chefProfile = chefProfileMap.get(item.assignedTo);
      if (!chef || !chefProfile) {
        throw new Error('الشيف غير صالح');
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      assignments.push(
        ProductionAssignment.findOneAndUpdate(
          { order: orderId, itemId },
          { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
          { upsert: true, session }
        )
      );

      chefNotifications.push({
        userId: item.assignedTo,
        messageKey: 'notifications.task_assigned',
        params: {
          chefName: chef.username || 'غير معروف',
          productName: orderItem.product.name || 'غير معروف',
          quantity: orderItem.quantity || 1,
          orderNumber: order.orderNumber || 'غير معروف',
          branchName: order.branch?.name || 'غير معروف',
        },
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'غير معروف',
          taskId: itemId,
          productId: orderItem.product._id,
          productName: orderItem.product.name,
          quantity: orderItem.quantity,
          eventId: `${itemId}-taskAssigned`,
        },
      });
    }

    await Promise.all(assignments);
    order.markModified('items');
    await order.save({ session });
    await syncOrderTasks(orderId, io, session);

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const taskAssignedEventData = {
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'غير معروف',
      eventId: `${orderId}-taskAssigned-${Date.now()}`,
    };

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'taskAssigned',
      'notifications.task_assigned',
      { orderNumber: order.orderNumber, branchName: order.branch?.name || 'غير معروف' },
      taskAssignedEventData,
      true
    );

    for (const chefNotif of chefNotifications) {
      await notifyUsers(
        io,
        [{ _id: chefNotif.userId }],
        'taskAssigned',
        chefNotif.messageKey,
        chefNotif.params,
        chefNotif.data,
        true
      );
    }

    const rooms = ['admin', 'production', `branch-${order.branch?._id}`];
    chefIds.forEach(chefId => rooms.push(`chef-${chefId}`));
    await emitSocketEvent(io, rooms, 'taskAssigned', {
      ...taskAssignedEventData,
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('branch', 'name').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status: ${order.status}, Order: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized role: ${req.user.role}, User: ${req.user.id}`);
      return res.status(403).json({ success: false, message: 'غير مخول لاعتماد الطلب' });
    }

    order.status = 'approved';
    order.approvedBy = req.user.id;
    order.approvedAt = new Date();
    order.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();

    const eventId = `${id}-orderApproved`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status: 'approved',
      eventId,
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'orderApproved',
      'notifications.order_approved_for_branch',
      { orderNumber: order.orderNumber, branchName: populatedOrder.branch?.name || 'غير معروف' },
      eventData,
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApproved', {
      ...eventData,
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const startTransit = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('branch', 'name').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, 'in_transit')) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status transition: ${order.status} to in_transit, Order: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'لا يمكن بدء الشحن في هذه الحالة' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized role: ${req.user.role}, User: ${req.user.id}`);
      return res.status(403).json({ success: false, message: 'غير مخول لبدء الشحن' });
    }

    order.status = 'in_transit';
    order.transitStartedAt = new Date();
    order.statusHistory.push({
      status: 'in_transit',
      changedBy: req.user.id,
      changedAt: new Date(),
      notes: 'Order shipped by production',
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();

    const eventId = `${id}-orderInTransit`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status: 'in_transit',
      eventId,
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'orderInTransit',
      'notifications.order_shipped_for_branch',
      { orderNumber: order.orderNumber, branchName: populatedOrder.branch?.name || 'غير معروف' },
      eventData,
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransit', {
      ...eventData,
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('branch', 'name').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, 'delivered')) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status transition: ${order.status} to delivered, Order: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'لا يمكن تأكيد التوصيل في هذه الحالة' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized role or branch: ${req.user.role}, Branch: ${req.user.branchId}, Order Branch: ${order.branch}, User: ${req.user.id}`);
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد التوصيل' });
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      changedAt: new Date(),
      notes: 'Delivery confirmed by branch',
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();

    const eventId = `${id}-orderDelivered`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status: 'delivered',
      eventId,
    };

    const messageKey = req.user.role === 'branch' ? 'notifications.order_delivered_for_branch' : 'notifications.order_delivered';
    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'orderDelivered',
      messageKey,
      { orderNumber: order.orderNumber, branchName: populatedOrder.branch?.name || 'غير معروف' },
      eventData,
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', {
      ...eventData,
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    if (!status) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Status is required:`, { userId: req.user.id });
      return res.status(400).json({ success: false, message: 'حالة الطلب مطلوبة' });
    }

    const order = await Order.findById(id).populate('branch', 'name').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status transition:`, {
        currentStatus: order.status,
        newStatus: status,
        userId: req.user.id,
      });
      return res.status(400).json({ success: false, message: 'انتقال الحالة غير صالح' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production' && (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString())) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized role or branch:`, {
        userRole: req.user.role,
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة الطلب' });
    }

    order.status = status;
    if (status === 'delivered') order.deliveredAt = new Date();
    if (status === 'in_transit') order.transitStartedAt = new Date();
    if (status === 'approved') order.approvedAt = new Date();
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
      notes: `Status updated to ${status}`,
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();

    const eventId = `${id}-orderStatusUpdated-${status}`;
    const eventType = status === 'delivered' ? 'orderDelivered' : 'orderStatusUpdated';
    const messageKey = status === 'delivered' ? 'notifications.order_delivered' : 'notifications.order_status_updated';
    const saveToDb = status === 'completed' || status === 'delivered';

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      eventType,
      messageKey,
      { orderNumber: order.orderNumber, status, branchName: populatedOrder.branch?.name || 'غير معروف' },
      { orderId: id, branchId: order.branch, eventId },
      saveToDb
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], eventType, {
      orderId: id,
      status,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmOrderReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch', 'name').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status: ${order.status}, Order: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التوصيل" لتأكيد الاستلام' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized role or branch:`, {
        userRole: req.user.role,
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد استلام الطلب' });
    }

    const branch = await Branch.findById(order.branch).session(session);
    if (!branch) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Branch not found: ${order.branch}, Order: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    for (const item of order.items) {
      const existingProduct = branch.inventory.find(i => i.product.toString() === item.product._id.toString());
      if (existingProduct) {
        existingProduct.quantity += item.quantity;
      } else {
        branch.inventory.push({
          product: item.product._id,
          quantity: item.quantity,
        });
      }
    }
    branch.markModified('inventory');
    await branch.save({ session });

    order.confirmedBy = req.user.id;
    order.confirmedAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      changedAt: new Date(),
      notes: 'Order receipt confirmed by branch',
    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();

    const eventId = `${id}-branchConfirmedReceipt`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      eventId,
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'branchConfirmedReceipt',
      'notifications.branch_confirmed_receipt',
      { orderNumber: order.orderNumber, branchName: populatedOrder.branch?.name || 'غير معروف' },
      eventData,
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'branchConfirmedReceipt', {
      ...eventData,
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming order receipt:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateItemStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, itemId } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order or item ID:`, { orderId, itemId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو العنصر غير صالح' });
    }

    const order = await Order.findById(orderId).populate('branch', 'name').populate('items.product', 'name').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const item = order.items.find(i => i._id.toString() === itemId);
    if (!item) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Item not found: ${itemId}, Order: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'العنصر غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch?._id,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const validItemStatuses = ['pending', 'assigned', 'in_progress', 'completed'];
    if (!validItemStatuses.includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid item status: ${status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'حالة العنصر غير صالحة' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (req.user.role === 'chef' && (!chefProfile || item.assignedTo.toString() !== req.user.id.toString())) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized chef access:`, {
        userId: req.user.id,
        assignedTo: item.assignedTo,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة هذا العنصر' });
    }

    item.status = status;
    if (status === 'in_progress') item.startedAt = new Date();
    if (status === 'completed') item.completedAt = new Date();

    const task = await ProductionAssignment.findOne({ order: orderId, itemId }).session(session);
    if (task) {
      task.status = status;
      if (status === 'in_progress') task.startedAt = new Date();
      if (status === 'completed') task.completedAt = new Date();
      await task.save({ session });
    }

    await order.save({ session });
    await syncOrderTasks(orderId, req.app.get('io'), session);

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();
    const chefUsers = item.assignedTo ? await User.find({ _id: item.assignedTo }).select('_id').lean() : [];

    const eventId = `${itemId}-${status === 'completed' ? 'itemCompleted' : 'itemStatusUpdated'}`;
    const eventType = status === 'completed' ? 'itemCompleted' : 'itemStatusUpdated';
    const messageKey = status === 'completed' ? 'notifications.item_completed' : 'notifications.item_status_updated';

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers],
      eventType,
      messageKey,
      {
        quantity: item.quantity || 1,
        productName: item.product?.name || 'غير معروف',
        orderNumber: order.orderNumber || 'غير معروف',
        branchName: order.branch?.name || 'غير معروف',
      },
      {
        orderId,
        itemId,
        status,
        branchId: order.branch?._id,
        chefId: item.assignedTo,
        eventId,
      },
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`, `chef-${item.assignedTo}`], eventType, {
      orderId,
      itemId,
      status,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'غير معروف',
      productName: item.product?.name || 'غير معروف',
      quantity: item.quantity || 1,
      eventId,
    });

    const allItemsCompleted = order.items.every(i => i.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: 'All items completed',
      });
      await order.save({ session });

      const completionEventId = `${orderId}-orderCompleted`;
      const completionMessageKey = req.user.role === 'branch' ? 'notifications.order_completed_for_branch' : 'notifications.order_completed';
      await notifyUsers(
        io,
        [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers],
        'orderCompleted',
        completionMessageKey,
        {
          orderNumber: order.orderNumber || 'غير معروف',
          branchName: order.branch?.name || 'غير معروف',
        },
        {
          orderId,
          branchId: order.branch?._id,
          eventId: completionEventId,
        },
        true
      );

      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`], 'orderCompleted', {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'غير معروف',
        status: 'completed',
        eventId: completionEventId,
      });
    }

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating item status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const checkMissingAssignments = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('branch', 'name').populate('items.product', 'name').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const missingAssignments = order.items.filter(item => !item.assignedTo && item.status === 'pending');
    if (missingAssignments.length === 0) {
      await session.commitTransaction();
      return res.status(200).json({ success: true, message: 'لا توجد عناصر غير معينة' });
    }

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    for (const item of missingAssignments) {
      const eventId = `${item._id}-missingAssignments`;
      await notifyUsers(
        io,
        [...adminUsers, ...productionUsers],
        'missingAssignments',
        'notifications.missing_assignments',
        {
          orderNumber: order.orderNumber || 'غير معروف',
          productName: item.product?.name || 'غير معروف',
          branchName: order.branch?.name || 'غير معروف',
        },
        {
          orderId: order._id,
          itemId: item._id,
          branchId: order.branch?._id,
          eventId,
        },
        true
      );

      await emitSocketEvent(io, ['admin', 'production'], 'missingAssignments', {
        orderId: order._id,
        itemId: item._id,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'غير معروف',
        productName: item.product?.name || 'غير معروف',
        eventId,
      });
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, message: 'تم إرسال إشعارات العناصر غير المعينة', missingAssignments });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error checking missing assignments:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  checkOrderExists,
  createOrder,
  getOrders,
  getOrderById,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
  updateItemStatus,
  createReturn,
  approveReturn,
  checkMissingAssignments,
};