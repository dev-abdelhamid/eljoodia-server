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

// دالة للتحقق من الكمية بناءً على الوحدة
const validateQuantity = (quantity, unit, isRtl) => {
  if (!quantity || quantity < 0) {
    throw new Error(isRtl ? 'الكمية يجب أن تكون أكبر من أو تساوي الصفر' : 'Quantity must be greater than or equal to zero');
  }
  if (unit === 'كيلو' || unit === 'Kilo') {
    if (quantity > 0 && (quantity < 0.5 || quantity % 0.5 !== 0)) {
      throw new Error(isRtl ? `الكمية ${quantity} يجب أن تكون مضاعف 0.5 لوحدة الكيلو` : `Quantity ${quantity} must be a multiple of 0.5 for Kilo unit`);
    }
  } else if (unit === 'قطعة' || unit === 'علبة' || unit === 'صينية' || unit === 'Piece' || unit === 'Pack' || unit === 'Tray') {
    if (!Number.isInteger(quantity)) {
      throw new Error(isRtl ? `الكمية ${quantity} يجب أن تكون عددًا صحيحًا لوحدة ${unit}` : `Quantity ${quantity} must be an integer for unit ${unit}`);
    }
  }
  return Number(quantity.toFixed(1));
};

// دالة لإرسال أحداث السوكت
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

// دالة لإشعار المستخدمين
const notifyUsers = async (io, users, type, message, data, saveToDb = false) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id.toString()),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
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
    unit: isRtl ? (item.unit || item.product?.unit || 'غير محدد') : (item.unitEn || item.product?.unitEn || item.product?.unit || 'N/A'),
    departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
    assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
    displayReturnReason: item.displayReturnReason,
    quantity: Number(item.quantity.toFixed(1)),
    shortageQuantity: item.shortageQuantity ? Number(item.shortageQuantity.toFixed(1)) : 0,
    shortageReason: item.shortageReason || '',
    shortageReasonEn: item.shortageReasonEn || '',
  })),
  shortages: order.shortages?.map(shortage => ({
    ...shortage,
    productName: isRtl ? shortage.product?.name : (shortage.product?.nameEn || shortage.product?.name || 'غير معروف'),
    unit: isRtl ? (shortage.unit || 'غير محدد') : (shortage.unitEn || shortage.unit || 'N/A'),
    quantity: Number(shortage.quantity.toFixed(1)),
  })) || [],
  createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'غير معروف'),
  statusHistory: order.statusHistory.map(history => ({
    ...history,
    displayNotes: history.displayNotes,
    changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
    changedAt: new Date(history.changedAt).toISOString(),
  })),
  adjustedTotal: order.adjustedTotal,
  createdAt: new Date(order.createdAt).toISOString(),
  isRtl,
});

// تعيين الشيفات لعناصر الطلب
const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { items, notes, notesEn } = req.body;
    const { id: orderId } = req.params;

    // التحقق من صحة البيانات
    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو مصفوفة العناصر غير صالحة' : 'Invalid order ID or items array' });
    }

    // جلب الطلب مع البيانات المرتبطة
    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name nameEn code isActive' } })
      .populate('branch')
      .setOptions({ context: { isRtl } })
      .session(session);

    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    // التحقق من الأذونات
    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' : 'Order must be in "approved" or "in_production" status to assign chefs' 
      });
    }

    // جلب بيانات الشيفات
    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));

    const io = req.app.get('io');
    const assignments = [];
    const chefNotifications = [];

    // معالجة تعيينات الشيفات
    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error(isRtl ? `معرفات غير صالحة: ${itemId}, ${item.assignedTo}` : `Invalid IDs: ${itemId}, ${item.assignedTo}`);
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(isRtl ? `العنصر ${itemId} غير موجود` : `Item ${itemId} not found`);
      }

      // جلب المنتج للتحقق من الوحدة
      const product = await Product.findById(orderItem.product._id).session(session);
      if (!product) {
        throw new Error(isRtl ? `المنتج ${orderItem.product._id} غير موجود` : `Product ${orderItem.product._id} not found`);
      }

      // التحقق من الكمية بناءً على الوحدة
      orderItem.quantity = validateQuantity(orderItem.quantity, product.unit, isRtl);

      const existingTask = await mongoose.model('ProductionAssignment').findOne({ order: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        throw new Error(isRtl ? 'لا يمكن إعادة تعيين المهمة لشيف آخر' : 'Cannot reassign task to another chef');
      }

      const chef = chefMap.get(item.assignedTo);
      const chefProfile = chefProfileMap.get(item.assignedTo);
      if (!chef || !chefProfile) {
        throw new Error(isRtl ? 'الشيف غير صالح' : 'Invalid chef');
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      assignments.push(
        mongoose.model('ProductionAssignment').findOneAndUpdate(
          { order: orderId, itemId },
          {
            chef: chefProfile._id,
            product: orderItem.product._id,
            quantity: orderItem.quantity,
            status: 'pending',
            itemId,
            order: orderId,
          },
          { upsert: true, session }
        )
      );

      chefNotifications.push({
        userId: item.assignedTo,
        message: isRtl
          ? `تم تعيينك لإنتاج ${orderItem.product.name} (كمية: ${orderItem.quantity.toFixed(1)}) في الطلب ${order.orderNumber}`
          : `Assigned to produce ${orderItem.product.nameEn || orderItem.product.name} (quantity: ${orderItem.quantity.toFixed(1)}) for order ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
          taskId: itemId,
          productId: orderItem.product._id,
          productName: isRtl ? orderItem.product.name : (orderItem.product.nameEn || orderItem.product.name),
          quantity: Number(orderItem.quantity.toFixed(1)),
          unit: isRtl ? product.unit : (product.unitEn || product.unit || 'N/A'),
          eventId: `${itemId}-task_assigned`,
          isRtl,
        },
      });
    }

    await Promise.all(assignments);
    order.markModified('items');
    order.statusHistory.push({
      status: order.status,
      changedBy: req.user.id,
      notes: notes?.trim() || (isRtl ? 'تم تعيين الشيفات' : 'Chefs assigned'),
      notesEn: notesEn?.trim() || 'Chefs assigned',
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });

    // جلب البيانات المملوءة للرد
    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    // إعداد بيانات الحدث
    const taskAssignedEventData = {
      _id: `${orderId}-taskAssigned-${Date.now()}`,
      type: 'taskAssigned',
      message: isRtl ? `تم تعيين الشيفات بنجاح للطلب ${order.orderNumber}` : `Chefs assigned successfully for order ${order.orderNumber}`,
      data: {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
        items: order.items.map(item => ({
          productId: item.product._id,
          productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
          quantity: Number(item.quantity.toFixed(1)),
          unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit || 'N/A'),
        })),
        eventId: `${orderId}-task_assigned`,
        isRtl,
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    // إشعار المستخدمين
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];
    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'taskAssigned',
      taskAssignedEventData.message,
      taskAssignedEventData.data,
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

    // إرسال حدث السوكت
    const rooms = new Set(['admin', 'production', `branch-${order.branch?._id}`]);
    chefIds.forEach(chefId => rooms.add(`chef-${chefId}`));
    await emitSocketEvent(io, rooms, 'taskAssigned', taskAssignedEventData);

    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};


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

    const order = await Order.findById(id)
      .populate('items.product')
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "في الطريق" لتأكيد التوصيل' : 'Order must be in "in_transit" status to confirm delivery' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتأكيد التوصيل' : 'Unauthorized to confirm delivery' });
    }

    // التحقق من الكميات بناءً على الوحدة
    for (const item of order.items) {
      const product = item.product;
      if (!product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, product.unit, isRtl);
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      notes: isRtl ? 'تم تأكيد التوصيل بواسطة الفرع' : 'Delivery confirmed by branch',
      notesEn: 'Delivery confirmed by branch',
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    const eventId = `${id}-order_delivered`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      status: 'delivered',
      eventId,
      isRtl,
    };

    await notifyUsers(
      io,
      usersToNotify,
      'orderDelivered',
      isRtl ? `تم توصيل الطلب ${order.orderNumber} إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}` : `Order ${order.orderNumber} delivered to branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      eventData,
      true
    );

    const orderData = {
      orderId: id,
      status: 'delivered',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', orderData);
    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
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

    const order = await Order.findById(id)
      .populate('items.product')
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة "معلق"' : 'Order is not in "pending" status' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لاعتماد الطلب' : 'Unauthorized to approve order' });
    }

    // التحقق من الكميات بناءً على الوحدة
    for (const item of order.items) {
      const product = item.product;
      if (!product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, product.unit, isRtl);
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
    await order.save({ session, context: { isRtl } });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    const eventId = `${id}-order_approved`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      status: 'approved',
      items: order.items.map(item => ({
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: Number(item.quantity.toFixed(1)),
        unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit || 'N/A'),
      })),
      eventId,
      isRtl,
    };

    await notifyUsers(
      io,
      usersToNotify,
      'orderApproved',
      isRtl ? `تم اعتماد الطلب ${order.orderNumber}` : `Order ${order.orderNumber} approved`,
      eventData,
      false
    );

    const orderData = {
      orderId: id,
      status: 'approved',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      items: populatedOrder.items.map(item => ({
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: Number(item.quantity.toFixed(1)),
        unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit || 'N/A'),
      })),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApproved', orderData);
    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
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

    const order = await Order.findById(id)
      .populate('items.product')
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' : 'Order must be in "completed" status to start transit' 
      });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لبدء التوصيل' : 'Unauthorized to start transit' });
    }

    // التحقق من الكميات بناءً على الوحدة
    for (const item of order.items) {
      const product = item.product;
      if (!product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, product.unit, isRtl);
    }

    order.status = 'in_transit';
    order.transitStartedAt = new Date();
    order.statusHistory.push({
      status: 'in_transit',
      changedBy: req.user.id,
      notes: isRtl ? 'تم شحن الطلب بواسطة الإنتاج' : 'Order shipped by production',
      notesEn: 'Order shipped by production',
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    const eventId = `${id}-order_in_transit`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      status: 'in_transit',
      items: order.items.map(item => ({
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: Number(item.quantity.toFixed(1)),
        unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit || 'N/A'),
      })),
      eventId,
      isRtl,
    };

    await notifyUsers(
      io,
      usersToNotify,
      'orderInTransit',
      isRtl ? `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}` : 
            `Order ${order.orderNumber} is on its way to branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      eventData,
      true
    );

    const orderData = {
      orderId: id,
      status: 'in_transit',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      items: populatedOrder.items.map(item => ({
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: Number(item.quantity.toFixed(1)),
        unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit || 'N/A'),
      })),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransit', orderData);
    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// تأكيد استلام الطلب بواسطة الفرع مع دعم الملاحظات والنواقص
const confirmOrderReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { notes, notesEn, shortages } = req.body; // إدخال الملاحظات والنواقص

    // التحقق من صحة معرف الطلب
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    // جلب الطلب مع البيانات المرتبطة
    const order = await Order.findById(id)
      .populate('items.product')
      .populate('branch')
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    // التحقق من حالة الطلب
    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'يجب أن يكون الطلب في حالة "في الطريق" لتأكيد الاستلام' : 'Order must be in "in_transit" status to confirm receipt',
      });
    }

    // التحقق من الأذونات
    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتأكيد استلام الطلب' : 'Unauthorized to confirm order receipt' });
    }

    // التحقق من الكميات بناءً على الوحدة ومعالجة النواقص
    const shortageMap = new Map(shortages?.map(s => [s.itemId.toString(), s]) || []);
    const inventoryUpdates = [];
    for (const item of order.items) {
      const product = item.product;
      if (!product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }

      // التحقق من الكمية المطلوبة
      item.quantity = validateQuantity(item.quantity, product.unit, isRtl);

      // معالجة النواقص إذا وجدت
      const shortage = shortageMap.get(item._id.toString());
      if (shortage) {
        // التحقق من صحة كمية النقص
        const shortageQuantity = validateQuantity(shortage.quantity, product.unit, isRtl);
        if (shortageQuantity > item.quantity) {
          throw new Error(
            isRtl
              ? `كمية النقص (${shortageQuantity}) للعنصر ${item.product.name} أكبر من الكمية المطلوبة (${item.quantity})`
              : `Shortage quantity (${shortageQuantity}) for item ${item.product.nameEn || item.product.name} exceeds ordered quantity (${item.quantity})`
          );
        }
        item.shortageQuantity = shortageQuantity;
        item.shortageReason = shortage.reason?.trim() || (isRtl ? 'غير محدد' : 'Not specified');
        item.shortageReasonEn = shortage.reasonEn?.trim() || 'Not specified';
        item.receivedQuantity = item.quantity - shortageQuantity;

        // إضافة النقص إلى حقل shortages في الطلب
        order.shortages = order.shortages || [];
        order.shortages.push({
          itemId: item._id,
          product: item.product._id,
          quantity: shortageQuantity,
          unit: product.unit,
          unitEn: product.unitEn || product.unit,
          reason: item.shortageReason,
          reasonEn: item.shortageReasonEn,
        });
      } else {
        item.receivedQuantity = item.quantity;
        item.shortageQuantity = 0;
        item.shortageReason = '';
        item.shortageReasonEn = '';
      }

      // تحديث المخزون بناءً على الكمية المستلمة
      if (item.receivedQuantity > 0) {
        inventoryUpdates.push(
          Inventory.findOneAndUpdate(
            { branch: order.branch, product: item.product._id },
            { $inc: { quantity: item.receivedQuantity } },
            { upsert: true, new: true, session }
          )
        );

        // تسجيل حركة المخزون
        inventoryUpdates.push(
          new InventoryHistory({
            branch: order.branch,
            product: item.product._id,
            quantity: item.receivedQuantity,
            unit: product.unit,
            unitEn: product.unitEn || product.unit,
            type: 'add',
            order: order._id,
            itemId: item._id,
            changedBy: req.user.id,
            notes: isRtl ? `إضافة إلى المخزون من الطلب ${order.orderNumber}` : `Added to inventory from order ${order.orderNumber}`,
            notesEn: `Added to inventory from order ${order.orderNumber}`,
          }).save({ session })
        );
      }
    }

    // تنفيذ تحديثات المخزون
    await Promise.all(inventoryUpdates);

    // تحديث حالة الطلب
    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      notes: notes?.trim() || (isRtl ? 'تم تأكيد استلام الطلب بواسطة الفرع' : 'Order receipt confirmed by branch'),
      notesEn: notesEn?.trim() || 'Order receipt confirmed by branch',
      changedAt: new Date(),
    });
    order.markModified('items');
    order.markModified('shortages');
    await order.save({ session, context: { isRtl } });

    // جلب البيانات المملوءة للرد
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    const eventId = `${id}-order_delivered`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      status: 'delivered',
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || '',
      items: order.items.map(item => ({
        itemId: item._id,
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: Number(item.quantity.toFixed(1)),
        receivedQuantity: Number(item.receivedQuantity.toFixed(1)),
        shortageQuantity: Number(item.shortageQuantity.toFixed(1)),
        shortageReason: item.shortageReason || '',
        shortageReasonEn: item.shortageReasonEn || '',
        unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit || 'N/A'),
      })),
      shortages: order.shortages.map(shortage => ({
        itemId: shortage.itemId,
        productId: shortage.product,
        productName: isRtl ? populatedOrder.items.find(i => i._id.toString() === shortage.itemId.toString())?.product.name : 
                     (populatedOrder.items.find(i => i._id.toString() === shortage.itemId.toString())?.product.nameEn || 'غير معروف'),
        quantity: Number(shortage.quantity.toFixed(1)),
        unit: isRtl ? shortage.unit : (shortage.unitEn || shortage.unit || 'N/A'),
        reason: shortage.reason || '',
        reasonEn: shortage.reasonEn || '',
      })),
      eventId,
      isRtl,
    };

    // إشعار المستخدمين بتأكيد الاستلام
    await notifyUsers(
      io,
      usersToNotify,
      'orderDelivered',
      isRtl
        ? `تم تأكيد استلام الطلب ${order.orderNumber} بواسطة الفرع ${populatedOrder.branch?.name || 'غير معروف'}`
        : `Order ${order.orderNumber} receipt confirmed by branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      eventData,
      true
    );

    // إشعار الإدارة والإنتاج بالنواقص إذا وجدت
    if (order.shortages?.length) {
      const shortageNotificationData = {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
        shortages: order.shortages.map(shortage => ({
          itemId: shortage.itemId,
          productId: shortage.product,
          productName: isRtl ? populatedOrder.items.find(i => i._id.toString() === shortage.itemId.toString())?.product.name : 
                       (populatedOrder.items.find(i => i._id.toString() === shortage.itemId.toString())?.product.nameEn || 'غير معروف'),
          quantity: Number(shortage.quantity.toFixed(1)),
          unit: isRtl ? shortage.unit : (shortage.unitEn || shortage.unit || 'N/A'),
          reason: shortage.reason || '',
          reasonEn: shortage.reasonEn || '',
        })),
        eventId: `${id}-shortages_reported`,
        isRtl,
      };

      const shortageUsers = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean();
      await notifyUsers(
        io,
        shortageUsers,
        'shortagesReported',
        isRtl
          ? `تم الإبلاغ عن نواقص في الطلب ${order.orderNumber} من الفرع ${populatedOrder.branch?.name || 'غير معروف'}`
          : `Shortages reported for order ${order.orderNumber} from branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
        shortageNotificationData,
        true
      );

      await emitSocketEvent(io, ['admin', 'production'], 'shortagesReported', shortageNotificationData);
    }

    // إرسال حدث السوكت لتأكيد الاستلام
    const orderData = {
      orderId: id,
      status: 'delivered',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      adjustedTotal: populatedOrder.adjustedTotal,
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || '',
      items: populatedOrder.items.map(item => ({
        itemId: item._id,
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: Number(item.quantity.toFixed(1)),
        receivedQuantity: Number(item.receivedQuantity.toFixed(1)),
        shortageQuantity: Number(item.shortageQuantity.toFixed(1)),
        shortageReason: item.shortageReason || '',
        shortageReasonEn: item.shortageReasonEn || '',
        unit: isRtl ? item.product.unit : (item.product.unitEn || item.product.unit || 'N/A'),
      })),
      shortages: eventData.shortages,
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', orderData);
    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming order receipt:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { assignChefs, approveOrder, startTransit, confirmDelivery, confirmOrderReceipt };