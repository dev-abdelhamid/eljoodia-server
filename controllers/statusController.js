const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const ProductionAssignment = require('../models/ProductionAssignment');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');

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
  const uniqueRooms = new Set(rooms);
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
    eventData: eventDataWithSound,
  });
};

const notifyUsers = async (io, users, type, messageKey, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, data, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
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
      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for assigning chefs: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' });
    }

    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));

    const io = req.app.get('io');
    const assignments = [];
    const taskAssignedEvents = [];
    const itemStatusEvents = [];

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

      taskAssignedEvents.push({
        _id: itemId,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: orderItem.product._id, name: orderItem.product.name, department: orderItem.product.department },
        chefId: item.assignedTo,
        chefName: chef.username || 'غير معروف',
        quantity: orderItem.quantity,
        itemId,
        status: 'pending',
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'غير معروف',
        eventId: `${itemId}-new_production_assigned_to_chef`,
      });

      itemStatusEvents.push({
        orderId,
        itemId,
        status: 'assigned',
        productName: orderItem.product.name,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'غير معروف',
        eventId: `${itemId}-item_status_updated`,
      });
    }

    await Promise.all(assignments);

    await notifyUsers(
      io,
      await User.find({ _id: { $in: items.map(i => i.assignedTo) } }).select('_id').lean(),
      'new_production_assigned_to_chef',
      'notifications.new_production_assigned_to_chef',
      { orderId, orderNumber: order.orderNumber, branchId: order.branch?._id, eventId: `${orderId}-new_production_assigned_to_chef` }
    );

    order.markModified('items');
    await order.save({ session });
    await syncOrderTasks(orderId, io, session);

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('returns')
      .lean();

    await Promise.all([
      ...taskAssignedEvents.map(event =>
        emitSocketEvent(io, [`chef-${event.chefId}`, `branch-${order.branch?._id}`, 'production', 'admin'], 'newProductionAssignedToChef', event)
      ),
      ...itemStatusEvents.map(event =>
        emitSocketEvent(io, [`branch-${order.branch?._id}`, 'production', 'admin'], 'itemStatusUpdated', event)
      ),
      emitSocketEvent(io, [`branch-${order.branch?._id}`, 'production', 'admin'], 'orderUpdated', {
        ...populatedOrder,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'غير معروف',
        adjustedTotal: populatedOrder.adjustedTotal,
        createdAt: new Date(populatedOrder.createdAt).toISOString(),
        eventId: `${orderId}-order_updated`,
      }),
    ]);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, { error: err.message, userId: req.user.id });
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

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for approval: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized approval attempt:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول لاعتماد الطلب' });
    }

    order.status = 'approved';
    order.approvedBy = req.user.id;
    order.approvedAt = new Date().toISOString();
    order.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      changedAt: new Date().toISOString(),
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
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    await notifyUsers(
      io,
      usersToNotify,
      'order_approved_for_branch',
      'notifications.order_approved_for_branch',
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_approved_for_branch` }
    );

    const orderData = {
      orderId: id,
      status: 'approved',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-order_approved_for_branch`,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApprovedForBranch', orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, { error: err.message, userId: req.user.id });
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

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for transit: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized transit attempt:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول لبدء التوصيل' });
    }

    order.status = 'in_transit';
    order.transitStartedAt = new Date().toISOString();
    order.statusHistory.push({
      status: 'in_transit',
      changedBy: req.user.id,
      changedAt: new Date().toISOString(),
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
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    await notifyUsers(
      io,
      usersToNotify,
      'order_in_transit_to_branch',
      'notifications.order_in_transit_to_branch',
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_in_transit_to_branch` }
    );

    const orderData = {
      orderId: id,
      status: 'in_transit',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-order_in_transit_to_branch`,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransitToBranch', orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, { error: err.message, userId: req.user.id });
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

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for delivery confirmation: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "في الطريق" لتأكيد التسليم' });
    }

    if (req.user.role !== 'branch' || order.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized delivery confirmation:`, { userId: req.user.id, role: req.user.role, userBranch: req.user.branchId, orderBranch: order.branch });
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد تسليم هذا الطلب' });
    }

    order.status = 'delivered';
    order.deliveredAt = new Date().toISOString();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      changedAt: new Date().toISOString(),
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
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    await notifyUsers(
      io,
      usersToNotify,
      'order_delivered',
      'notifications.order_delivered',
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_delivered` }
    );

    const orderData = {
      orderId: id,
      status: 'delivered',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-order_delivered`,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status transition:`, { current: order.status, new: status, userId: req.user.id });
      return res.status(400).json({ success: false, message: `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (req.user.role === 'branch' && status !== 'delivered') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized status update by branch:`, { userId: req.user.id, status });
      return res.status(403).json({ success: false, message: 'الفرع مخول فقط لتحديث الحالة إلى "تم التسليم"' });
    }

    if (['approved', 'in_production', 'completed', 'in_transit'].includes(status) && req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized status update:`, { userId: req.user.id, role: req.user.role, status });
      return res.status(403).json({ success: false, message: `غير مخول لتحديث الحالة إلى ${status}` });
    }

    if (status === 'delivered') {
      order.deliveredAt = new Date().toISOString();
    } else if (status === 'in_transit') {
      order.transitStartedAt = new Date().toISOString();
    } else if (status === 'approved') {
      order.approvedAt = new Date().toISOString();
      order.approvedBy = req.user.id;
    }

    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date().toISOString(),
      notes: notes?.trim(),
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
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    let notificationType = 'order_status_updated';
    let messageKey = 'notifications.order_status_updated';

    if (status === 'delivered') {
      notificationType = 'order_delivered';
      messageKey = 'notifications.order_delivered';
    } else if (status === 'in_transit') {
      notificationType = 'order_in_transit_to_branch';
      messageKey = 'notifications.order_in_transit_to_branch';
    } else if (status === 'approved') {
      notificationType = 'order_approved_for_branch';
      messageKey = 'notifications.order_approved_for_branch';
    }

    await notifyUsers(
      io,
      usersToNotify,
      notificationType,
      messageKey,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-${notificationType}` }
    );

    const orderData = {
      orderId: id,
      status,
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      notes: notes?.trim(),
      eventId: `${id}-${notificationType}`,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], notificationType, orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, { error: err.message, userId: req.user.id });
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

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for receipt confirmation: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم" لتأكيد الاستلام' });
    }

    if (req.user.role !== 'branch' || order.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized receipt confirmation:`, { userId: req.user.id, role: req.user.role, userBranch: req.user.branchId, orderBranch: order.branch });
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد استلام هذا الطلب' });
    }

    order.confirmedReceipt = true;
    order.confirmedReceiptAt = new Date().toISOString();
    order.confirmedBy = req.user.id;

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
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    await notifyUsers(
      io,
      usersToNotify,
      'branch_confirmed_receipt',
      'notifications.branch_confirmed_receipt',
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-branch_confirmed_receipt` }
    );

    const orderData = {
      orderId: id,
      status: order.status,
      confirmedReceipt: true,
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-branch_confirmed_receipt`,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'branchConfirmed', orderData);

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming order receipt:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { assignChefs, approveOrder, startTransit, confirmDelivery, updateOrderStatus, confirmOrderReceipt };