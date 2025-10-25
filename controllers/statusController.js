const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { createNotification } = require('../utils/notifications');

// دالة للتحقق من صحة ObjectId
const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// دالة للتحقق من الانتقالات المسموح بها لحالة الطلب
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

// دالة للتحقق من صحة الكمية بناءً على الوحدة
const validateQuantity = (quantity, unit, isRtl) => {
  if (!quantity || quantity <= 0) {
    throw new Error(isRtl ? 'الكمية يجب أن تكون أكبر من الصفر' : 'Quantity must be greater than zero');
  }
  if (unit === 'كيلو' || unit === 'Kilo') {
    if (quantity % 0.5 !== 0) {
      throw new Error(isRtl ? `الكمية ${quantity} يجب أن تكون مضاعف 0.5 لوحدة الكيلو` : `Quantity ${quantity} must be a multiple of 0.5 for Kilo unit`);
    }
  } else if (['قطعة', 'علبة', 'صينية', 'Piece', 'Pack', 'Tray'].includes(unit)) {
    if (!Number.isInteger(quantity)) {
      throw new Error(isRtl ? `الكمية ${quantity} يجب أن تكون عددًا صحيحًا لوحدة ${unit}` : `Quantity ${quantity} must be an integer for unit ${unit}`);
    }
  }
  return Number(quantity.toFixed(1));
};

// دالة لإرسال أحداث السوكت
const emitSocketEvent = (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

// دالة لإشعار المستخدمين
const notifyUsers = async (io, users, type, message, data, saveToDb = false) => {
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }
};

// دالة لتحضير بيانات الطلب المعروضة
const prepareOrderResponse = (order, isRtl) => ({
  ...order,
  branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
  displayNotes: order.displayNotes,
  items: order.items.map(item => ({
    ...item,
    productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
    unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
    departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
    assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
    displayReturnReason: item.displayReturnReason,
    quantity: Number(item.quantity.toFixed(1)),
    startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
    completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
    isCompleted: item.status === 'completed',
  })),
  createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'غير معروف'),
  statusHistory: order.statusHistory.map(history => ({
    ...history,
    displayNotes: history.displayNotes,
    changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
    changedAt: new Date(history.changedAt).toISOString(),
  })),
  adjustedTotal: order.adjustedTotal,
  createdAt: new Date(order.createdAt).toISOString(),
  approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
  transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
  deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
  isRtl,
});

// تعيين الشيفات
const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { items, notes, notesEn } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو العناصر غير صالحة' : 'Invalid order ID or items' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department' } })
      .populate('branch')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    if (!['approved', 'in_production'].includes(order.status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة صالحة لتعيين الشيفات' : 'Order not in valid status for chef assignment' });
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
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error(isRtl ? `معرف العنصر ${item.itemId} أو الشيف ${item.assignedTo} غير صالح` : `Invalid item ID ${item.itemId} or chef ID ${item.assignedTo}`);
      }

      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      if (!orderItem) {
        throw new Error(isRtl ? `العنصر ${item.itemId} غير موجود` : `Item ${item.itemId} not found`);
      }

      const product = await Product.findById(orderItem.product._id).session(session);
      if (!product) {
        throw new Error(isRtl ? `المنتج ${orderItem.product._id} غير موجود` : `Product ${orderItem.product._id} not found`);
      }

      orderItem.quantity = validateQuantity(orderItem.quantity, product.unit, isRtl);

      const existingTask = await mongoose.model('ProductionAssignment').findOne({ order: orderId, itemId: item.itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        throw new Error(isRtl ? 'لا يمكن إعادة تعيين المهمة لشيف آخر' : 'Cannot reassign task to another chef');
      }

      const chef = chefMap.get(item.assignedTo);
      if (!chef || !chefProfileMap.get(item.assignedTo)) {
        throw new Error(isRtl ? 'الشيف غير صالح' : 'Invalid chef');
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      assignments.push(
        mongoose.model('ProductionAssignment').findOneAndUpdate(
          { order: orderId, itemId: item.itemId },
          { chef: chefProfileMap.get(item.assignedTo)._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId: item.itemId, order: orderId },
          { upsert: true, session }
        )
      );

      chefNotifications.push({
        userId: item.assignedTo,
        message: isRtl ? `تم تعيينك لإنتاج ${orderItem.product.name} (كمية: ${orderItem.quantity.toFixed(1)})` : `Assigned to produce ${orderItem.product.nameEn || orderItem.product.name} (quantity: ${orderItem.quantity.toFixed(1)})`,
        data: { orderId, orderNumber: order.orderNumber, branchId: order.branch?._id, taskId: item.itemId, productId: orderItem.product._id, quantity: orderItem.quantity, eventId: `${item.itemId}-task_assigned`, isRtl },
      });
    }

    await Promise.all(assignments);
    order.markModified('items');
    order.statusHistory.push({ status: order.status, changedBy: req.user.id, notes: notes?.trim() || (isRtl ? 'تم تعيين الشيفات' : 'Chefs assigned'), notesEn: notesEn?.trim() || 'Chefs assigned', changedAt: new Date() });
    await order.save({ session });

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean().session(session);

    const taskAssignedEventData = {
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || 'غير معروف'),
      eventId: `${orderId}-task_assigned`,
      isRtl,
    };

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];

    await notifyUsers(io, [...adminUsers, ...productionUsers, ...branchUsers], 'taskAssigned', isRtl ? `تم تعيين الشيفات للطلب ${order.orderNumber}` : `Chefs assigned for order ${order.orderNumber}`, taskAssignedEventData, false);
    for (const chefNotif of chefNotifications) {
      await notifyUsers(io, [{ _id: chefNotif.userId }], 'taskAssigned', chefNotif.message, chefNotif.data, false);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`, ...chefIds.map(id => `chef-${id}`)], 'taskAssigned', taskAssignedEventData);
    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// اعتماد الطلب
const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة معلق' : 'Order is not pending' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لاعتماد الطلب' : 'Unauthorized to approve order' });
    }

    for (const item of order.items) {
      if (!item.product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, item.product.unit, isRtl);
    }

    order.status = 'approved';
    order.approvedBy = req.user.id;
    order.approvedAt = new Date();
    order.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      notes: isRtl ? 'تم اعتماد الطلب' : 'Order approved',
      notesEn: 'Order approved',
      changedAt: new Date(),
    });
    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean().session(session);

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [{ role: { $in: ['admin', 'production'] } }, { role: 'branch', branch: order.branch }],
    }).select('_id').lean();

    const eventId = `${id}-order_approved`;
    await notifyUsers(io, usersToNotify, 'orderApproved', isRtl ? `تم اعتماد الطلب ${order.orderNumber}` : `Order ${order.orderNumber} approved`, { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId, isRtl }, false);
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApproved', prepareOrderResponse(populatedOrder, isRtl));

    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// بدء النقل
const startTransit = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة مكتمل' : 'Order is not completed' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لبدء التوصيل' : 'Unauthorized to start transit' });
    }

    for (const item of order.items) {
      if (!item.product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, item.product.unit, isRtl);
    }

    order.status = 'in_transit';
    order.transitStartedAt = new Date();
    order.statusHistory.push({
      status: 'in_transit',
      changedBy: req.user.id,
      notes: isRtl ? 'تم شحن الطلب' : 'Order shipped',
      notesEn: 'Order shipped',
      changedAt: new Date(),
    });
    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean().session(session);

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [{ role: { $in: ['admin', 'production'] } }, { role: 'branch', branch: order.branch }],
    }).select('_id').lean();

    const eventId = `${id}-order_in_transit`;
    await notifyUsers(io, usersToNotify, 'orderInTransit', isRtl ? `الطلب ${order.orderNumber} في الطريق` : `Order ${order.orderNumber} in transit`, { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId, isRtl }, true);
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransit', prepareOrderResponse(populatedOrder, isRtl));

    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// تأكيد التوصيل
const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة في الطريق' : 'Order is not in transit' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتأكيد التوصيل' : 'Unauthorized to confirm delivery' });
    }

    for (const item of order.items) {
      if (!item.product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, item.product.unit, isRtl);

      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        {
          $inc: { currentStock: item.quantity },
          $push: { movements: { type: 'in', quantity: item.quantity, reference: `تسليم طلب #${order.orderNumber}`, createdBy: req.user.id, createdAt: new Date() } },
        },
        { new: true, upsert: true, session }
      );

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: order.branch,
        action: 'delivery',
        quantity: item.quantity,
        reference: `تسليم طلب #${order.orderNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      notes: isRtl ? 'تم تأكيد التوصيل' : 'Delivery confirmed',
      notesEn: 'Delivery confirmed',
      changedAt: new Date(),
    });
    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean().session(session);

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [{ role: { $in: ['admin', 'production'] } }, { role: 'branch', branch: order.branch }],
    }).select('_id').lean();

    const eventId = `${id}-order_delivered`;
    await notifyUsers(io, usersToNotify, 'orderDelivered', isRtl ? `تم توصيل الطلب ${order.orderNumber}` : `Order ${order.orderNumber} delivered`, { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId, isRtl }, true);
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', prepareOrderResponse(populatedOrder, isRtl));

    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// تحديث حالة الطلب
const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { status, notes, notesEn } = req.body;

    if (!isValidObjectId(id) || !status) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو الحالة غير صالحة' : 'Invalid order ID or status' });
    }

    const order = await Order.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? `لا يمكن تغيير الحالة إلى ${status}` : `Cannot transition to status ${status}` });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production' && (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث الحالة' : 'Unauthorized to update status' });
    }

    for (const item of order.items) {
      if (!item.product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, item.product.unit, isRtl);
    }

    order.status = status;
    if (status === 'delivered') order.deliveredAt = new Date();
    if (status === 'in_transit') order.transitStartedAt = new Date();
    if (status === 'approved') order.approvedAt = new Date();
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: notes?.trim() || (isRtl ? `تم تحديث الحالة إلى ${status}` : `Status updated to ${status}`),
      notesEn: notesEn?.trim() || `Status updated to ${status}`,
      changedAt: new Date(),
    });
    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean().session(session);

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [{ role: { $in: ['admin', 'production'] } }, { role: 'branch', branch: order.branch }],
    }).select('_id').lean();

    const eventId = `${id}-order_status_updated-${status}`;
    const eventType = status === 'delivered' ? 'orderDelivered' : 'orderStatusUpdated';
    await notifyUsers(io, usersToNotify, eventType, isRtl ? `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}` : `Order ${order.orderNumber} status updated to ${status}`, { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, status, eventId, isRtl }, status === 'delivered' || status === 'completed');
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], eventType, prepareOrderResponse(populatedOrder, isRtl));

    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// تأكيد استلام الطلب
const confirmOrderReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب لم يتم تسليمه بعد' : 'Order not delivered yet' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتأكيد الاستلام' : 'Unauthorized to confirm receipt' });
    }

    const branch = await Branch.findById(order.branch).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    for (const item of order.items) {
      if (!item.product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      const formattedQuantity = validateQuantity(item.quantity, item.product.unit, isRtl);
      const existingProduct = branch.inventory.find(i => i.product.toString() === item.product._id.toString());
      if (existingProduct) {
        existingProduct.quantity = Number((existingProduct.quantity + formattedQuantity).toFixed(1));
      } else {
        branch.inventory.push({ product: item.product._id, quantity: formattedQuantity });
      }
    }

    branch.markModified('inventory');
    await branch.save({ session });

    order.confirmedBy = req.user.id;
    order.confirmedAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      notes: isRtl ? 'تم تأكيد الاستلام' : 'Receipt confirmed',
      notesEn: 'Receipt confirmed',
      changedAt: new Date(),
    });
    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean().session(session);

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [{ role: { $in: ['admin', 'production'] } }, { role: 'branch', branch: order.branch }],
    }).select('_id').lean();

    const eventId = `${id}-branch_confirmed_receipt`;
    await notifyUsers(io, usersToNotify, 'branchConfirmedReceipt', isRtl ? `تم تأكيد استلام الطلب ${order.orderNumber}` : `Order ${order.orderNumber} receipt confirmed`, { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId, isRtl }, true);
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'branchConfirmed', prepareOrderResponse(populatedOrder, isRtl));

    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming order receipt:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
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