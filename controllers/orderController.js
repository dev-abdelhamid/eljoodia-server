const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
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
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms,
    eventData: { ...eventData, sound: eventData.sound, vibrate: eventData.vibrate }
  });
};

// إنشاء طلب
const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderNumber, items, status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, user: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing orderNumber or items:`, { orderNumber, items });
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
      statusHistory: [{ status, changedBy: req.user.id, changedAt: new Date() }],
    });

    await newOrder.save({ session });

    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const notifyRoles = ['production', 'admin'];
    const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_created',
        `طلب جديد ${orderNumber} تم إنشاؤه بواسطة الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
        { orderId: newOrder._id, orderNumber, branchId: branch },
        io
      );
    }

    const orderData = {
      ...populatedOrder,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-created.mp3',
      vibrate: [300, 100, 300],
    };
    await emitSocketEvent(io, [branch.toString(), 'production', 'admin'], 'orderCreated', orderData);

    await session.commitTransaction();
    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// تعيين الشيفات
const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for assigning chefs: ${order.status}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' });
    }

    const io = req.app.get('io');
    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid itemId or assignedTo:`, { itemId, assignedTo: item.assignedTo });
        return res.status(400).json({ success: false, message: 'معرفات غير صالحة' });
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order item not found: ${itemId}`);
        return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود` });
      }

      // Check if task already exists to prevent reassignment
      const existingTask = await ProductionAssignment.findOne({ order: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Attempt to reassign task:`, { taskId: existingTask._id, currentChef: existingTask.chef, newChef: item.assignedTo });
        return res.status(400).json({ success: false, message: 'لا يمكن إعادة تعيين المهمة لشيف آخر' });
      }

      const chef = await User.findById(item.assignedTo).populate('department').lean();
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo }).session(session).lean();
      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department?._id.toString() !== orderItem.product.department?._id.toString()) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, { chefId: item.assignedTo, department: orderItem.product.department?._id });
        return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع القسم' });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      orderItem.department = orderItem.product.department;

      await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId },
        { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
        { upsert: true, session }
      );

      await createNotification(
        item.assignedTo,
        'task_assigned',
        `تم تعيينك لإنتاج ${orderItem.product.name} للطلب ${order.orderNumber}`,
        { taskId: itemId, orderId, orderNumber: order.orderNumber, branchId: order.branch?._id },
        io
      );

      const taskAssignedEvent = {
        _id: itemId,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: orderItem.product._id, name: orderItem.product.name, department: orderItem.product.department },
        chef: { _id: chefProfile._id, username: chef.name || 'Unknown' }, // Use chefProfile._id here
        quantity: orderItem.quantity,
        itemId,
        status: 'pending',
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        sound: '/notification.mp3',
        vibrate: [400, 100, 400],
      };
      await emitSocketEvent(io, [
        `chef-${chefProfile._id}`, // Use chefProfile._id
        `branch-${order.branch?._id}`,
        'production',
        'admin',
        `department-${orderItem.product.department?._id}`
      ], 'taskAssigned', taskAssignedEvent);

      const itemStatusEvent = {
        orderId,
        itemId,
        status: 'assigned',
        productName: orderItem.product.name,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        sound: '/status-updated.mp3',
        vibrate: [200, 100, 200],
      };
      await emitSocketEvent(io, [`branch-${order.branch?._id}`, 'production', 'admin'], 'itemStatusUpdated', itemStatusEvent);
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .lean();

    const orderData = {
      ...populatedOrder,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
      sound: '/order-updated.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [order.branch?._id.toString(), 'production', 'admin'], 'orderUpdated', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// استرجاع الطلبات
const getOrders = async (req, res) => {
  try {
    const { status, branch } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    orders.forEach(order => order.items.forEach(item => item.isCompleted = item.status === 'completed'));

    res.status(200).json(orders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// استرجاع طلب معين
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    order.items.forEach(item => item.isCompleted = item.status === 'completed');
    res.status(200).json(order);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// اعتماد الطلب
const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for approval: ${order.status}`);
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized approval attempt:`, { userId: req.user.id, role: req.user.role });
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
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin'] }, branchId: order.branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_approved',
        `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
        io
      );
    }

    const orderData = {
      orderId: id,
      status: 'approved',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-approved.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// بدء التوصيل
const startTransit = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for transit: ${order.status}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized transit attempt:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول لبدء التوصيل' });
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
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_in_transit',
        `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
        io
      );
    }

    const orderData = {
      orderId: id,
      status: 'in_transit',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-in-transit.mp3',
      vibrate: [300, 100, 300],
    };
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderInTransit', {
      ...orderData,
      transitStartedAt: new Date().toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// تحديث حالة الطلب
const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status transition:`, { current: order.status, new: status });
      return res.status(400).json({ success: false, message: `الانتقال من ${order.status} إلى ${status} غير مسموح` });
    }

    order.status = status;
    if (notes) order.notes = notes.trim();
    order.statusHistory.push({ status, changedBy: req.user.id, notes, changedAt: new Date() });
    await order.save({ session });

    await syncOrderTasks(id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const notifyRoles = {
      approved: ['production'],
      in_production: ['chef', 'branch'],
      in_transit: ['branch', 'admin'],
      cancelled: ['branch', 'production', 'admin'],
      delivered: ['branch', 'admin'],
      completed: ['branch', 'admin'],
    }[status] || [];

    const io = req.app.get('io');
    if (notifyRoles.length) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch }).select('_id').lean();
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
          { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
          io
        );
      }
    }

    const orderData = {
      orderId: id,
      status,
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/status-updated.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);

    if (status === 'completed') {
      const completedEventData = {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderCompleted', completedEventData);
    }

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// تأكيد التسليم
const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch').session(session);
    if (!order || order.status !== 'in_transit') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for delivery:`, { status: order?.status, orderId: id });
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    for (const item of order.items) {
      await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        { $inc: { currentStock: item.quantity - (item.returnedQuantity || 0) } },
        { upsert: true, session }
      );
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({ status: 'delivered', changedBy: req.user.id });
    await order.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] }, branchId: order.branch?._id }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_delivered',
        `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${order.branch?.name || 'Unknown'}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch?._id },
        io
      );
    }

    const orderData = {
      orderId: id,
      status: 'delivered',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
      deliveredAt: new Date().toISOString(),
      sound: '/order-delivered.mp3',
      vibrate: [300, 100, 300],
    };
    await emitSocketEvent(io, [order.branch?._id.toString(), 'production', 'admin'], 'orderStatusUpdated', orderData);
    await emitSocketEvent(io, [order.branch?._id.toString(), 'production', 'admin'], 'orderDelivered', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// الموافقة على الإرجاع
const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return ID: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(id).populate('order').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Return not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return status: ${status}`);
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized return approval:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع' });
    }

    if (status === 'approved') {
      const order = await Order.findById(returnRequest.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order not found for return: ${returnRequest.order._id}`);
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }

      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Order item not found for return: ${returnItem.itemId}`);
          return res.status(400).json({ success: false, message: `العنصر ${returnItem.itemId} غير موجود في الطلب` });
        }
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: returnItem.product },
          { $inc: { currentStock: -returnItem.quantity } },
          { upsert: true, session }
        );
      }
      order.markModified('items');
      await order.save({ session });
    }

    returnRequest.status = status;
    if (reviewNotes) returnRequest.reviewNotes = reviewNotes.trim();
    await returnRequest.save({ session });

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order?.branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order?.orderNumber || 'Unknown'}`,
        { returnId: id, orderId: returnRequest.order?._id, orderNumber: returnRequest.order?.orderNumber },
        io
      );
    }

    const returnData = {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
      sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
      vibrate: [200, 100, 200],
    };
    await emitSocketEvent(io, [returnRequest.order?.branch.toString(), 'admin', 'production'], 'returnStatusUpdated', returnData);

    await session.commitTransaction();
    res.status(200).json(returnRequest);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createOrder, assignChefs, getOrders, getOrderById, approveOrder, startTransit, updateOrderStatus, confirmDelivery, approveReturn }; 
