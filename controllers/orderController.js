const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { NotificationService } = require('../utils/notifications');
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

const checkOrderExists = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in checkOrderExists:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, { error: err.message, userId: req.user.id });
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
      throw new Error('معرف الفرع مطلوب ويجب أن يكون صالحًا');
    }
    if (!orderNumber || !items?.length) {
      throw new Error('رقم الطلب ومصفوفة العناصر مطلوبة');
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

    const products = await Product.find({ _id: { $in: mergedItems.map(i => i.product) } })
      .select('name price unit department')
      .populate('department', 'name code')
      .session(session)
      .lean();

    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.product.toString());
      if (!product) throw new Error(`المنتج ${item.product} غير موجود`);
      item.price = product.price;
    }

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
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch },
      ],
    }).select('_id').lean();

    const message = `طلب جديد ${orderNumber} تم إنشاؤه بواسطة ${populatedOrder.branch?.name || 'Unknown'}`;
    for (const user of users) {
      await NotificationService.createNotification(user._id, 'new_order_from_branch', message, {
        orderId: newOrder._id,
        orderNumber,
        branchId: branch,
        eventId: `${newOrder._id}-new_order_from_branch`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'newOrderFromBranch', {
      ...populatedOrder,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${newOrder._id}-new_order_from_branch`,
    });

    await session.commitTransaction();
    res.status(201).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { branchId, status, priority, limit = 50, skip = 0 } = req.query;
    const query = {};

    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    }
    if (status) {
      query.status = status;
    }
    if (priority) {
      query.priority = priority;
    }
    if (req.user.role === 'branch') {
      query.branch = req.user.branchId;
    }

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(skip))
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .lean();

    const total = await Order.countDocuments(query);

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

    res.status(200).json({
      success: true,
      data: formattedOrders,
      total,
      limit: Number(limit),
      skip: Number(skip),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, err);
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

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
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

    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { items, status, notes, priority } = req.body;

    if (!isValidObjectId(id)) {
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لتحديث هذا الطلب');
    }

    if (status && !validateStatusTransition(order.status, status)) {
      throw new Error(`انتقال الحالة من ${order.status} إلى ${status} غير صالح`);
    }

    if (status && ['approved', 'in_production', 'completed', 'in_transit'].includes(status) && req.user.role !== 'admin' && req.user.role !== 'production') {
      throw new Error(`غير مخول لتحديث الحالة إلى ${status}`);
    }

    if (items) {
      const mergedItems = items.reduce((acc, item) => {
        if (!isValidObjectId(item.product)) {
          throw new Error(`معرف المنتج غير صالح: ${item.product}`);
        }
        const existing = acc.find(i => i.product.toString() === item.product.toString());
        if (existing) existing.quantity += item.quantity;
        else acc.push({ ...item, status: item.status || 'pending', startedAt: null, completedAt: null });
        return acc;
      }, []);

      const products = await Product.find({ _id: { $in: mergedItems.map(i => i.product) } })
        .select('name price unit department')
        .session(session)
        .lean();

      for (const item of mergedItems) {
        const product = products.find(p => p._id.toString() === item.product.toString());
        if (!product) throw new Error(`المنتج ${item.product} غير موجود`);
        item.price = product.price;
      }

      order.items = mergedItems.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: item.status,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      }));
      order.totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);
      order.adjustedTotal = order.totalAmount;
    }

    if (status) {
      order.status = status;
      order.statusHistory.push({
        status,
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: notes?.trim(),
      });
      if (status === 'approved') {
        order.approvedBy = req.user.id;
        order.approvedAt = new Date();
      } else if (status === 'in_transit') {
        order.transitStartedAt = new Date();
      } else if (status === 'delivered') {
        order.deliveredAt = new Date();
      }
    }
    if (notes) order.notes = notes.trim();
    if (priority) order.priority = priority;

    await order.save({ session });
    await syncOrderTasks(order._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    if (status) {
      const users = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: order.branch },
        ],
      }).select('_id').lean();

      let notificationType = 'order_status_updated';
      let notificationMessage = `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`;
      if (status === 'delivered') {
        notificationType = 'order_delivered';
        notificationMessage = `تم تسليم الطلب ${order.orderNumber} إلى ${populatedOrder.branch?.name || 'Unknown'}`;
      } else if (status === 'in_transit') {
        notificationType = 'order_in_transit_to_branch';
        notificationMessage = `الطلب ${order.orderNumber} في طريقه إلى ${populatedOrder.branch?.name || 'Unknown'}`;
      } else if (status === 'approved') {
        notificationType = 'order_approved_for_branch';
        notificationMessage = `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`;
      }

      for (const user of users) {
        await NotificationService.createNotification(user._id, notificationType, notificationMessage, {
          orderId: id,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${id}-${notificationType}`,
        }, io);
      }

      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], notificationType, {
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
    console.error(`[${new Date().toISOString()}] Error updating order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, items, notes } = req.body;

    if (!isValidObjectId(orderId) || !items?.length) {
      throw new Error('معرف الطلب ومصفوفة العناصر مطلوبة');
    }

    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لهذا الفرع');
    }

    if (order.status !== 'delivered') {
      throw new Error('يجب أن يكون الطلب في حالة "تم التسليم" لإنشاء طلب إرجاع');
    }

    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.product) || !item.quantity || !['defective', 'wrong_item', 'other'].includes(item.reason)) {
        throw new Error('بيانات العنصر غير صالحة');
      }
      const orderItem = order.items.find(i => i._id.toString() === item.itemId.toString());
      if (!orderItem || orderItem.product._id.toString() !== item.product.toString()) {
        throw new Error(`العنصر ${item.itemId} غير موجود أو لا يتطابق مع المنتج`);
      }
      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
        throw new Error(`الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${item.itemId}`);
      }
    }

    const newReturn = new Return({
      order: orderId,
      items: items.map(item => ({
        itemId: item.itemId,
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      status: 'pending_approval',
      createdBy: req.user.id,
      createdAt: new Date(),
      reviewNotes: notes?.trim(),
    });

    await newReturn.save({ session });

    order.returns.push(newReturn._id);
    await order.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();

    for (const user of users) {
      await NotificationService.createNotification(user._id, 'return_status_updated', `تم إنشاء طلب إرجاع جديد للطلب ${order.orderNumber}`, {
        returnId: newReturn._id,
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${newReturn._id}-return_status_updated`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnStatusUpdated', {
      returnId: newReturn._id,
      orderId,
      status: 'pending_approval',
      branchId: order.branch,
      branchName: populatedReturn.order?.branch?.name || 'Unknown',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      eventId: `${newReturn._id}-return_status_updated`,
    });

    await session.commitTransaction();
    res.status(201).json(populatedReturn);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      throw new Error('معرف الإرجاع غير صالح');
    }

    if (!['approved', 'rejected'].includes(status)) {
      throw new Error('حالة غير صالحة');
    }

    const returnRequest = await Return.findById(id).populate('order').populate('items.product').session(session);
    if (!returnRequest) {
      throw new Error('الإرجاع غير موجود');
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      throw new Error('غير مخول للموافقة على الإرجاع');
    }

    const order = await Order.findById(returnRequest.order._id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    let adjustedTotal = order.adjustedTotal;
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          throw new Error(`العنصر ${returnItem.itemId} غير موجود في الطلب`);
        }
        if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          throw new Error(`الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${returnItem.itemId}`);
        }
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        adjustedTotal -= returnItem.quantity * orderItem.price;
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: returnItem.product },
          { $inc: { currentStock: returnItem.quantity } },
          { upsert: true, session }
        );
      }
      order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;
      order.markModified('items');
      await order.save({ session });
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .session(session)
      .lean();

    const populatedOrder = await Order.findById(returnRequest.order._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.order?.branch },
      ],
    }).select('_id').lean();

    for (const user of users) {
      await NotificationService.createNotification(user._id, 'return_status_updated', `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order?.orderNumber || 'Unknown'}`, {
        returnId: id,
        orderId: returnRequest.order?._id,
        orderNumber: returnRequest.order?.orderNumber,
        branchId: returnRequest.order?.branch,
        eventId: `${id}-return_status_updated`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.order?.branch}`], 'returnStatusUpdated', {
      returnId: id,
      orderId: returnRequest.order?._id,
      status,
      reviewNotes,
      branchId: returnRequest.order?.branch,
      branchName: populatedReturn.order?.branch?.name || 'Unknown',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: populatedOrder.adjustedTotal,
      eventId: `${id}-return_status_updated`,
    });

    await session.commitTransaction();
    res.status(200).json({ ...populatedReturn, adjustedTotal: populatedOrder.adjustedTotal });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId) || !items?.length) {
      throw new Error('معرف الطلب أو مصفوفة العناصر غير صالحة');
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لهذا الفرع');
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      throw new Error('يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات');
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

    for (const user of await User.find({ _id: { $in: items.map(i => i.assignedTo) } }).select('_id').lean()) {
      await NotificationService.createNotification(user._id, 'new_production_assigned_to_chef', `تم تعيينك لإنتاج عنصر في الطلب ${order.orderNumber}`, {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        eventId: `${orderId}-new_production_assigned_to_chef`,
      }, io);
    }

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
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
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
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }
    if (order.status !== 'pending') {
      throw new Error('الطلب ليس في حالة "معلق"');
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      throw new Error('غير مخول لاعتماد الطلب');
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
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();

    const message = `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`;
    for (const user of users) {
      await NotificationService.createNotification(user._id, 'order_approved_for_branch', message, {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${id}-order_approved_for_branch`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApprovedForBranch', {
      orderId: id,
      status: 'approved',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-order_approved_for_branch`,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const cancelOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }
    if (!['pending', 'approved', 'in_production'].includes(order.status)) {
      throw new Error('لا يمكن إلغاء الطلب في هذه الحالة');
    }
    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لإلغاء هذا الطلب');
    }

    order.status = 'cancelled';
    order.cancelledBy = req.user.id;
    order.cancelledAt = new Date();
    order.statusHistory.push({
      status: 'cancelled',
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
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();

    const message = `تم إلغاء الطلب ${order.orderNumber} بواسطة ${req.user.username}`;
    for (const user of users) {
      await NotificationService.createNotification(user._id, 'order_status_updated', message, {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${id}-order_status_updated`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', {
      orderId: id,
      status: 'cancelled',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-order_status_updated`,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error cancelling order:`, err);
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
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }
    if (order.status !== 'completed') {
      throw new Error('يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل');
    }
    if (req.user.role !== 'production') {
      throw new Error('غير مخول لبدء التوصيل');
    }

    order.status = 'in_transit';
    order.transitStartedAt = new Date();
    order.statusHistory.push({
      status: 'in_transit',
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
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();

    const message = `الطلب ${order.orderNumber} في طريقه إلى ${populatedOrder.branch?.name || 'Unknown'}`;
    for (const user of users) {
      await NotificationService.createNotification(user._id, 'order_in_transit_to_branch', message, {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${id}-order_in_transit_to_branch`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransitToBranch', {
      orderId: id,
      status: 'in_transit',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-order_in_transit_to_branch`,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, err);
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
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    if (order.status !== 'in_transit') {
      throw new Error('يجب أن يكون الطلب في حالة "في الطريق" لتأكيد التسليم');
    }

    if (req.user.role !== 'branch' || order.branch?.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لتأكيد تسليم هذا الطلب');
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
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
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();

    const message = `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${populatedOrder.branch?.name || 'Unknown'}`;
    for (const user of users) {
      await NotificationService.createNotification(user._id, 'order_delivered', message, {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${id}-order_delivered`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', {
      orderId: id,
      status: 'delivered',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId: `${id}-order_delivered`,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err);
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
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    if (order.status !== 'delivered') {
      throw new Error('يجب أن يكون الطلب في حالة "تم التسليم" لتأكيد الاستلام');
    }

    if (req.user.role !== 'branch' || order.branch?.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لتأكيد استلام هذا الطلب');
    }

    order.confirmedReceipt = true;
    order.confirmedReceiptAt = new Date();
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
    const users = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id').lean();

    const message = `تم تأكيد استلام الطلب ${order.orderNumber} بواسطة ${req.user.username}`;
    for (const user of users) {
      await NotificationService.createNotification(user._id, 'branch_confirmed_receipt', message, {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${id}-branch_confirmed_receipt`,
      }, io);
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'branchConfirmed', {
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
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming order receipt:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const deleteOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }
    if (req.user.role !== 'admin') {
      throw new Error('غير مخول لحذف الطلب');
    }

    await ProductionAssignment.deleteMany({ order: id }).session(session);
    await order.deleteOne({ session });

    const io = req.app.get('io');
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDeleted', {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      eventId: `${id}-order_deleted`,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, message: 'تم حذف الطلب بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error deleting order:`, err);
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
  updateOrder,
  createReturn,
  approveReturn,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  confirmOrderReceipt,
};