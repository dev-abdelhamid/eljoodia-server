const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { createNotification } = require('../utils/notifications');

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

// إعادة استخدام دوال المساعدة من orderController
const { populateOrder, formatOrder, notifyAndEmit, getUsersToNotify } = require('./orderController');

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' });
    }

    const chefIds = items.map((item) => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map((c) => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map((p) => [p.user.toString(), p]));

    const io = req.app.get('io');
    const assignments = [];
    const chefNotifications = [];

    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error(`معرفات غير صالحة: ${itemId}, ${item.assignedTo}`);
      }

      const orderItem = order.items.find((i) => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(`العنصر ${itemId} غير موجود`);
      }

      const existingTask = await mongoose.model('ProductionAssignment').findOne({ order: orderId, itemId }).session(session);
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
        mongoose.model('ProductionAssignment').findOneAndUpdate(
          { order: orderId, itemId },
          { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
          { upsert: true, session }
        )
      );

      chefNotifications.push({
        userId: item.assignedTo,
        message: `تم تعيينك لإنتاج ${orderItem.product.name} في الطلب ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'غير معروف',
          taskId: itemId,
          productId: orderItem.product._id,
          productName: orderItem.product.name,
          quantity: orderItem.quantity,
          eventId: `${itemId}-task_assigned`,
        },
      });
    }

    await Promise.all(assignments);
    order.markModified('items');
    await order.save({ session });

    const populatedOrder = await populateOrder(Order.findById(orderId)).session(session).lean();
    const usersToNotify = await getUsersToNotify(order.branch?._id);

    const taskAssignedEventData = {
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'غير معروف',
      eventId: `${orderId}-task_assigned`,
    };

    await notifyAndEmit(
      io,
      usersToNotify,
      ['admin', 'production', `branch-${order.branch?._id}`, ...chefIds.map((id) => `chef-${id}`)],
      'taskAssigned',
      `تم تعيين الشيفات بنجاح للطلب ${order.orderNumber}`,
      taskAssignedEventData,
      false
    );

    for (const chefNotif of chefNotifications) {
      await notifyAndEmit(io, [{ _id: chefNotif.userId }], [`chef-${chefNotif.userId}`], 'taskAssigned', chefNotif.message, chefNotif.data, false);
    }

    await session.commitTransaction();
    res.status(200).json(formatOrder(populatedOrder));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, {
      error: err.message,
      userId: req.user.id,
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
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

    const populatedOrder = await populateOrder(Order.findById(id)).session(session).lean();
    const io = req.app.get('io');
    const usersToNotify = await getUsersToNotify(order.branch);

    const eventId = `${id}-order_approved`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status: 'approved',
      eventId,
    };

    await notifyAndEmit(io, usersToNotify, ['admin', 'production', `branch-${order.branch}`], 'orderApproved', `تم اعتماد الطلب ${order.orderNumber}`, eventData, false);

    await session.commitTransaction();
    res.status(200).json(formatOrder(populatedOrder));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, {
      error: err.message,
      userId: req.user.id,
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لبدء التوصيل' });
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

    const populatedOrder = await populateOrder(Order.findById(id)).session(session).lean();
    const io = req.app.get('io');
    const usersToNotify = await getUsersToNotify(order.branch);

    const eventId = `${id}-order_in_transit`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status: 'in_transit',
      eventId,
    };

    await notifyAndEmit(
      io,
      usersToNotify,
      ['admin', 'production', `branch-${order.branch}`],
      'orderInTransit',
      `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      eventData,
      true
    );

    await session.commitTransaction();
    res.status(200).json(formatOrder(populatedOrder));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, {
      error: err.message,
      userId: req.user.id,
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "في الطريق" لتأكيد التوصيل' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
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

    const populatedOrder = await populateOrder(Order.findById(id)).session(session).lean();
    const io = req.app.get('io');
    const usersToNotify = await getUsersToNotify(order.branch);

    const eventId = `${id}-order_delivered`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status: 'delivered',
      eventId,
    };

    await notifyAndEmit(
      io,
      usersToNotify,
      ['admin', 'production', `branch-${order.branch}`],
      'orderDelivered',
      `تم توصيل الطلب ${order.orderNumber} إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      eventData,
      true
    );

    await session.commitTransaction();
    res.status(200).json(formatOrder(populatedOrder));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, {
      error: err.message,
      userId: req.user.id,
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    if (!status) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحالة مطلوبة' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production' && (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة الطلب' });
    }

    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
      notes: `Status updated to ${status}`,
    });

    if (status === 'delivered') order.deliveredAt = new Date();
    if (status === 'in_transit') order.transitStartedAt = new Date();
    if (status === 'approved') order.approvedAt = new Date();

    await order.save({ session });

    const populatedOrder = await populateOrder(Order.findById(id)).session(session).lean();
    const io = req.app.get('io');
    const usersToNotify = await getUsersToNotify(order.branch);

    const eventId = `${id}-order_status_updated-${status}`;
    const eventType = status === 'delivered' ? 'orderDelivered' : 'orderStatusUpdated';
    const messageKey = status === 'delivered' ? `تم توصيل الطلب ${order.orderNumber}` : `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`;

    await notifyAndEmit(
      io,
      usersToNotify,
      ['admin', 'production', `branch-${order.branch}`],
      eventType,
      messageKey,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, status, eventId },
      status === 'completed' || status === 'delivered'
    );

    await session.commitTransaction();
    res.status(200).json(formatOrder(populatedOrder));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, {
      error: err.message,
      userId: req.user.id,
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التوصيل" لتأكيد الاستلام' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد استلام الطلب' });
    }

    const branch = await Branch.findById(order.branch).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    for (const item of order.items) {
      const existingProduct = branch.inventory.find((i) => i.product.toString() === item.product._id.toString());
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

    const populatedOrder = await populateOrder(Order.findById(id)).session(session).lean();
    const io = req.app.get('io');
    const usersToNotify = await getUsersToNotify(order.branch);

    const eventId = `${id}-branch_confirmed_receipt`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      eventId,
    };

    await notifyAndEmit(
      io,
      usersToNotify,
      ['admin', 'production', `branch-${order.branch}`],
      'branchConfirmedReceipt',
      `تم تأكيد استلام الطلب ${order.orderNumber} بواسطة الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      eventData,
      true
    );

    await session.commitTransaction();
    res.status(200).json(formatOrder(populatedOrder));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming order receipt:`, {
      error: err.message,
      userId: req.user.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
};