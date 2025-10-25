const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
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
    if (quantity < 0.5 || quantity % 0.5 !== 0) {
      throw new Error(isRtl ? `الكمية ${quantity} يجب أن تكون مضاعف 0.5 لوحدة الكيلو` : `Quantity ${quantity} must be a multiple of 0.5 for Kilo unit`);
    }
  } else if (unit === 'قطعة' || unit === 'علبة' || unit === 'صينية' || unit === 'Piece' || unit === 'Pack' || unit === 'Tray') {
    if (!Number.isInteger(quantity)) {
      throw new Error(isRtl ? `الكمية ${quantity} يجب أن تكون عددًا صحيحًا لوحدة ${unit}` : `Quantity ${quantity} must be an integer for unit ${unit}`);
    }
  }
  return Number(quantity.toFixed(1));
};

// دالة لإرسال أحداث السوكت مع بيانات إضافية
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

// دالة لإشعار المستخدمين مع دعم التخزين في قاعدة البيانات
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
    unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
    departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
    assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
    displayReturnReason: item.displayReturnReason,
    quantity: Number(item.quantity.toFixed(1)),
  })),
  createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'غير معروف'),
  statusHistory: order.statusHistory.map(history => ({
    ...history,
    displayNotes: history.displayNotes,
    changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
  })),
  adjustedTotal: order.adjustedTotal,
  createdAt: new Date(order.createdAt).toISOString(),
  isRtl,
});

// إنشاء طلب جديد
const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { items, notes, notesEn } = req.body;
    const user = req.user;

    // التحقق من صحة البيانات
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'مصفوفة العناصر مطلوبة ويجب ألا تكون فارغة' : 'Items array is required and must not be empty',
      });
    }

    // التحقق من صلاحية الفرع
    if (user.role !== 'branch' || !isValidObjectId(user.branchId)) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لإنشاء الطلب' : 'Unauthorized to create order',
      });
    }

    const branch = await Branch.findById(user.branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الفرع غير موجود' : 'Branch not found',
      });
    }

    // التحقق من العناصر
    const productIds = items.map(item => item.product).filter(isValidObjectId);
    const products = await Product.find({ _id: { $in: productIds }, isActive: true })
      .select('name nameEn price unit unitEn department')
      .populate('department', 'name nameEn code')
      .session(session)
      .lean();

    const productMap = new Map(products.map(p => [p._id.toString(), p]));
    let adjustedTotal = 0;

    const validatedItems = [];
    for (const item of items) {
      const { product: productId, quantity, price } = item;

      // التحقق من معرف المنتج
      if (!isValidObjectId(productId)) {
        throw new Error(isRtl ? `معرف المنتج ${productId} غير صالح` : `Invalid product ID ${productId}`);
      }

      const product = productMap.get(productId.toString());
      if (!product) {
        throw new Error(isRtl ? `المنتج ${productId} غير موجود أو غير نشط` : `Product ${productId} not found or inactive`);
      }

      // التحقق من السعر
      if (!price || price <= 0 || price !== product.price) {
        throw new Error(
          isRtl
            ? `السعر ${price} للمنتج ${product.name} غير صالح أو لا يتطابق مع السعر المسجل (${product.price})`
            : `Price ${price} for product ${product.nameEn || product.name} is invalid or does not match recorded price (${product.price})`
        );
      }

      // التحقق من الكمية
      const validatedQuantity = validateQuantity(quantity, product.unit, isRtl);

      // إضافة العنصر إلى القائمة
      validatedItems.push({
        product: productId,
        quantity: validatedQuantity,
        price: product.price,
        subtotal: Number((validatedQuantity * product.price).toFixed(2)),
      });

      adjustedTotal += validatedQuantity * product.price;
    }

    // إنشاء الطلب
    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const order = new Order({
      orderNumber,
      branch: user.branchId,
      createdBy: user.id,
      items: validatedItems,
      adjustedTotal: Number(adjustedTotal.toFixed(2)),
      status: 'pending',
      displayNotes: notes?.trim() || '',
      displayNotesEn: notesEn?.trim() || '',
      statusHistory: [
        {
          status: 'pending',
          changedBy: user.id,
          notes: isRtl ? 'تم إنشاء الطلب' : 'Order created',
          notesEn: 'Order created',
          changedAt: new Date(),
        },
      ],
    });

    await order.save({ session, context: { isRtl } });

    // جلب البيانات المملوءة للرد
    const populatedOrder = await Order.findById(order._id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn code' },
      })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    // إشعار المستخدمين
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [{ role: { $in: ['admin', 'production'] } }, { role: 'branch', branch: order.branch }],
    })
      .select('_id role')
      .lean();

    const eventId = `${order._id}-order_created`;
    const eventData = {
      orderId: order._id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      status: 'pending',
      eventId,
      isRtl,
    };

    await notifyUsers(
      io,
      usersToNotify,
      'orderCreated',
      isRtl ? `تم إنشاء الطلب ${order.orderNumber} بواسطة الفرع ${populatedOrder.branch?.name || 'غير معروف'}` : `Order ${order.orderNumber} created by branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      eventData,
      true
    );

    const orderData = {
      orderId: order._id,
      status: 'pending',
      user: { id: user.id, username: user.username },
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

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCreated', orderData);
    await session.commitTransaction();
    res.status(201).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, {
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

// جلب جميع الطلبات
const getOrders = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    let query = {};

    if (req.user.role === 'branch') {
      query.branch = req.user.branchId;
    }

    const orders = await Order.find(query)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn code' },
      })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .lean();

    const response = orders.map(order => prepareOrderResponse(order, isRtl));
    res.status(200).json(response);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
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

// جلب طلب معين
const getOrderById = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
      });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn code' },
      })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الطلب غير موجود' : 'Order not found',
      });
    }

    if (req.user.role === 'branch' && order.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لهذا الطلب' : 'Unauthorized for this order',
      });
    }

    res.status(200).json(prepareOrderResponse(order, isRtl));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order:`, {
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

// التحقق من وجود الطلب
const checkOrderExists = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
      });
    }

    const order = await Order.findById(id).lean();
    if (!order) {
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الطلب غير موجود' : 'Order not found',
      });
    }

    res.status(200).json({ success: true, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, {
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
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' : 'Order must be in "approved" or "in_production" status to assign chefs' });
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
          quantity: orderItem.quantity,
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
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' : 'Order must be in "completed" status to start transit' });
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
      eventId,
      isRtl,
    };

    await notifyUsers(
      io,
      usersToNotify,
      'orderInTransit',
      isRtl ? `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}` : `Order ${order.orderNumber} is on its way to branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
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

// تحديث حالة الطلب
const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { status, notes, notesEn } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    if (!status) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الحالة مطلوبة' : 'Status is required' });
    }

    const order = await Order.findById(id)
      .populate('items.product')
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` : `Cannot change status from ${order.status} to ${status}` });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production' && (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث حالة الطلب' : 'Unauthorized to update order status' });
    }

    // التحقق من الكميات بناءً على الوحدة
    for (const item of order.items) {
      const product = item.product;
      if (!product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      item.quantity = validateQuantity(item.quantity, product.unit, isRtl);
    }

    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: notes?.trim() || `Status updated to ${status}`,
      notesEn: notesEn?.trim() || `Status updated to ${status}`,
      changedAt: new Date(),
    });

    if (status === 'delivered') order.deliveredAt = new Date();
    if (status === 'in_transit') order.transitStartedAt = new Date();
    if (status === 'approved') order.approvedAt = new Date();
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

    const eventId = `${id}-order_status_updated-${status}`;
    const eventType = status === 'delivered' ? 'orderDelivered' : 'orderStatusUpdated';
    const messageKey = status === 'delivered'
      ? isRtl ? `تم توصيل الطلب ${order.orderNumber}` : `Order ${order.orderNumber} delivered`
      : isRtl ? `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}` : `Order ${order.orderNumber} status updated to ${status}`;

    const saveToDb = status === 'completed' || status === 'delivered';
    await notifyUsers(
      io,
      usersToNotify,
      eventType,
      messageKey,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, status, eventId, isRtl },
      saveToDb
    );

    const orderData = {
      orderId: id,
      status,
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

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], eventType, orderData);
    await session.commitTransaction();
    res.status(200).json(prepareOrderResponse(populatedOrder, isRtl));
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
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

    const order = await Order.findById(id)
      .populate('items.product')
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "تم التوصيل" لتأكيد الاستلام' : 'Order must be in "delivered" status to confirm receipt' });
    }

    if (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتأكيد استلام الطلب' : 'Unauthorized to confirm order receipt' });
    }

    const branch = await Branch.findById(order.branch).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    // تحديث المخزون
    for (const item of order.items) {
      const product = item.product;
      if (!product) {
        throw new Error(isRtl ? `المنتج ${item.product._id} غير موجود` : `Product ${item.product._id} not found`);
      }
      const formattedQuantity = validateQuantity(item.quantity, product.unit, isRtl);
      const existingProduct = branch.inventory.find(i => i.product.toString() === item.product._id.toString());
      if (existingProduct) {
        existingProduct.quantity = Number((existingProduct.quantity + formattedQuantity).toFixed(1));
      } else {
        branch.inventory.push({
          product: item.product._id,
          quantity: formattedQuantity,
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
      notes: isRtl ? 'تم تأكيد استلام الطلب بواسطة الفرع' : 'Order receipt confirmed by branch',
      notesEn: 'Order receipt confirmed by branch',
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

    const eventId = `${id}-branch_confirmed_receipt`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      eventId,
      isRtl,
    };

    await notifyUsers(
      io,
      usersToNotify,
      'branchConfirmedReceipt',
      isRtl ? `تم تأكيد استلام الطلب ${order.orderNumber} بواسطة الفرع ${populatedOrder.branch?.name || 'غير معروف'}` : `Order ${order.orderNumber} receipt confirmed by branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
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

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'branchConfirmed', orderData);
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

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  checkOrderExists,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
};