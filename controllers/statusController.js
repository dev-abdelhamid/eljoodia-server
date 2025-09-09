const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { emitSocketEvent, notifyUsers } = require('../utils/notifications');

/**
 * التحقق من صحة انتقال الحالة
 * @param {string} currentStatus - الحالة الحالية
 * @param {string} newStatus - الحالة الجديدة
 * @returns {boolean} صحة الانتقال
 */
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

/**
 * تعيين الشيفات للطلب
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const assignChefs = async (req, res) => {
  try {
    const { items } = req.body;
    const { id: orderId } = req.params;
    if (!mongoose.isValidObjectId(orderId) || !items?.length) {
      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });
    }
    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }
    if (order.status !== 'approved' && order.status !== 'in_production') {
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' });
    }
    const chefIds = items.map(item => item.assignedTo).filter(mongoose.isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));
    const io = req.app.get('io');
    const assignments = [];
    const chefNotifications = [];
    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!mongoose.isValidObjectId(itemId) || !mongoose.isValidObjectId(item.assignedTo)) {
        throw new Error(`معرفات غير صالحة: ${itemId}, ${item.assignedTo}`);
      }
      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(`العنصر ${itemId} غير موجود`);
      }
      const existingTask = await mongoose.model('ProductionAssignment').findOne({ order: orderId, itemId }).lean();
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        throw new Error('لا يمكن إعادة تعيين المهمة لشيف آخر');
      }
      const chef = chefMap.get(item.assignedTo);
      const chefProfile = chefProfileMap.get(item.assignedTo);
      if (!chef || !chefProfile) {
        throw new Error('الشيف غير صالح');
      }
      assignments.push(
        mongoose.model('ProductionAssignment').findOneAndUpdate(
          { order: orderId, itemId },
          { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
          { upsert: true, new: true }
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
          eventId: `${itemId}-taskAssigned`,
          chefId: item.assignedTo,
        },
      });
    }
    await Promise.all(assignments);
    await Order.updateOne(
      { _id: orderId },
      { $set: { items: order.items.map(i => (i._id.toString() === items.find(it => it.itemId === i._id.toString())?.itemId ? { ...i, assignedTo: items.find(it => it.itemId === i._id.toString()).assignedTo, status: 'assigned' } : i)) } }
    );
    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();
    const taskAssignedEventData = {
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'غير معروف',
      eventId: `${orderId}-taskAssigned`,
    };
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch?._id },
      ],
    }).select('_id').lean();
    await notifyUsers(
      io,
      users,
      'taskAssigned',
      `تم تعيين الشيفات بنجاح للطلب ${order.orderNumber}`,
      taskAssignedEventData,
      false
    );
    for (const chefNotif of chefNotifications) {
      await notifyUsers(
        io,
        [{ _id: chefNotif.userId }],
        'taskAssigned',
        chefNotif.message,
        chefNotif.data,
        false
      );
    }
    const rooms = new Set(['admin', 'production', `branch-${order.branch?._id}`]);
    chefIds.forEach(chefId => rooms.add(`chef-${chefId}`));
    await emitSocketEvent(io, rooms, 'taskAssigned', taskAssignedEventData);
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * اعتماد الطلب
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const approveOrder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"' });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      return res.status(403).json({ success: false, message: 'غير مخول لاعتماد الطلب' });
    }
    await Order.updateOne(
      { _id: id },
      {
        $set: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date() },
        $push: { statusHistory: { status: 'approved', changedBy: req.user.id, changedAt: new Date() } },
      }
    );
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();
    const io = req.app.get('io');
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();
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
      users,
      'orderApproved',
      `تم اعتماد الطلب ${order.orderNumber}`,
      eventData,
      false
    );
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApproved', eventData);
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error approving order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * بدء النقل
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const startTransit = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' });
    }
    if (req.user.role !== 'production') {
      return res.status(403).json({ success: false, message: 'غير مخول لبدء التوصيل' });
    }
    await Order.updateOne(
      { _id: id },
      {
        $set: { status: 'in_transit', transitStartedAt: new Date() },
        $push: { statusHistory: { status: 'in_transit', changedBy: req.user.id, changedAt: new Date(), notes: 'Order shipped by production' } },
      }
    );
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();
    const io = req.app.get('io');
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();
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
      users,
      'orderInTransit',
      `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      eventData,
      false
    );
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransit', eventData);
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error starting transit:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * تأكيد التوصيل
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const confirmDelivery = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (order.status !== 'in_transit') {
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "في الطريق" لتأكيد التوصيل' });
    }
    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد التوصيل' });
    }
    await Order.updateOne(
      { _id: id },
      {
        $set: { status: 'delivered', deliveredAt: new Date() },
        $push: { statusHistory: { status: 'delivered', changedBy: req.user.id, changedAt: new Date(), notes: 'Delivery confirmed by branch' } },
      }
    );
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();
    const io = req.app.get('io');
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();
    const eventId = `${id}-orderDelivered`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status: 'delivered',
      eventId,
    };
    await notifyUsers(
      io,
      users,
      'orderDelivered',
      `تم توصيل الطلب ${order.orderNumber} إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      eventData,
      false
    );
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', eventData);
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * تحديث حالة الطلب
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    if (!status) {
      return res.status(400).json({ success: false, message: 'الحالة مطلوبة' });
    }
    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (!validateStatusTransition(order.status, status)) {
      return res.status(400).json({ success: false, message: `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production' && (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString())) {
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة الطلب' });
    }
    const updateData = { status };
    if (status === 'delivered') updateData.deliveredAt = new Date();
    if (status === 'in_transit') updateData.transitStartedAt = new Date();
    if (status === 'approved') updateData.approvedAt = new Date();
    await Order.updateOne(
      { _id: id },
      {
        $set: updateData,
        $push: { statusHistory: { status, changedBy: req.user.id, changedAt: new Date(), notes: `Status updated to ${status}` } },
      }
    );
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();
    const io = req.app.get('io');
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();
    const eventId = `${id}-orderStatusUpdated-${status}`;
    const eventType = status === 'delivered' ? 'orderDelivered' : 'orderStatusUpdated';
    const message = status === 'delivered' ? `تم توصيل الطلب ${order.orderNumber}` : `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
      status,
      eventId,
    };
    await notifyUsers(io, users, eventType, message, eventData, false);
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], eventType, eventData);
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating order status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

/**
 * تأكيد استلام الطلب
 * @param {Object} req - كائن الطلب
 * @param {Object} res - كائن الاستجابة
 */
const confirmOrderReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    const order = await Order.findById(id).populate('items.product').lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التوصيل" لتأكيد الاستلام' });
    }
    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد استلام الطلب' });
    }
    const branch = await Branch.findById(order.branch);
    if (!branch) {
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
    await branch.save();
    await Order.updateOne(
      { _id: id },
      {
        $set: { confirmedBy: req.user.id, confirmedAt: new Date() },
        $push: { statusHistory: { status: 'delivered', changedBy: req.user.id, changedAt: new Date(), notes: 'Order receipt confirmed by branch' } },
      }
    );
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();
    const io = req.app.get('io');
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();
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
      users,
      'branchConfirmedReceipt',
      `تم تأكيد استلام الطلب ${order.orderNumber} بواسطة الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      eventData,
      false
    );
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'branchConfirmedReceipt', eventData);
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error confirming order receipt:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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