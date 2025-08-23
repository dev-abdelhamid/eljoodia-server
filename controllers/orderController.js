const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { createNotification } = require('../utils/notifications');
const { emitSocketEvent, notifyUsers } = require('../utils/socketUtils');
const { isValidObjectId, validateStatusTransition } = require('../utils/validation');

// إنشاء طلب مع المهام
const createOrderWithTasks = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderNumber, items, tasks = [], status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    // التحقق من المدخلات
    if (!branch || !isValidObjectId(branch) || !orderNumber || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، رقم الطلب، والعناصر مطلوبة وصالحة' });
    }

    // التحقق من أدوار المستخدم
    if (req.user.role !== 'branch' && req.user.role !== 'admin') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء الطلبات' });
    }

    // دمج العناصر المتشابهة
    const mergedItems = Array.from(
      items.reduce((map, item) => {
        if (!isValidObjectId(item.product)) throw new Error(`معرف المنتج غير صالح: ${item.product}`);
        const key = item.product.toString();
        const existing = map.get(key) || { ...item, quantity: 0, status: 'pending', startedAt: null, completedAt: null };
        existing.quantity += item.quantity;
        return map.set(key, existing);
      }, new Map()).values()
    );

    // التحقق من أن كل منتج مرتبط بقسم
    const invalidProducts = [];
    for (const item of mergedItems) {
      const product = await Product.findById(item.product).select('department').lean().session(session);
      if (!product?.department) {
        invalidProducts.push(item.product);
      }
    }
    if (invalidProducts.length > 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.no_department_assigned', errorDetails: `المنتجات التالية غير مرتبطة بقسم: ${invalidProducts.join(', ')}` });
    }

    // إنشاء الطلب
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

    // إنشاء المهام
    const io = req.app.get('io');
    for (const task of tasks) {
      if (!isValidObjectId(task.product) || !isValidObjectId(task.chef) || !task.quantity || !isValidObjectId(task.itemId)) {
        console.warn(`[${new Date().toISOString()}] Skipping invalid task:`, task);
        continue;
      }
      const orderItem = newOrder.items.id(task.itemId);
      if (!orderItem || orderItem.product.toString() !== task.product) {
        console.warn(`[${new Date().toISOString()}] Invalid task itemId or product mismatch:`, task);
        continue;
      }

      const chefProfile = await mongoose.model('Chef').findOne({ user: task.chef }).select('_id').session(session);
      if (!chefProfile) {
        console.warn(`[${new Date().toISOString()}] Chef not found for task:`, task);
        continue;
      }

      const newAssignment = new ProductionAssignment({
        order: newOrder._id,
        product: task.product,
        chef: chefProfile._id,
        quantity: task.quantity,
        itemId: task.itemId,
        status: 'pending',
      });
      await newAssignment.save({ session });

      orderItem.status = 'assigned';
      orderItem.assignedTo = task.chef;
      orderItem.department = (await Product.findById(task.product).select('department').lean()).department;

      await notifyUsers(io, [{ _id: task.chef }], 'task_assigned',
        `تم تعيينك لإنتاج ${orderItem.product?.name || 'Unknown'} للطلب ${orderNumber}`,
        { taskId: task.itemId, orderId: newOrder._id, orderNumber, branchId: branch }
      );
    }

    newOrder.markModified('items');
    await newOrder.save({ session });

    // مزامنة المهام
    await syncOrderTasks(newOrder._id, io, session);

    // جلب البيانات المملوءة
    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // إشعار المستخدمين
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin'] }, branchId: branch }).select('_id').lean();
    await notifyUsers(io, usersToNotify, 'order_created',
      `طلب جديد ${orderNumber} تم إنشاؤه بواسطة الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
      { orderId: newOrder._id, orderNumber, branchId: branch }
    );

    await emitSocketEvent(io, [branch.toString(), 'production', 'admin'], 'orderCreated', {
      ...populatedOrder,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-created.mp3',
      vibrate: [300, 100, 300],
    });

    await session.commitTransaction();
    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order with tasks:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
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

    const enhancedOrders = orders.map(order => ({
      ...order,
      items: order.items.map(item => ({ ...item, isCompleted: item.status === 'completed' })),
    }));

    res.status(200).json(enhancedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  }
};

// استرجاع طلب معين
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: 'errors.order_not_found' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
    }

    const enhancedOrder = {
      ...order,
      items: order.items.map(item => ({ ...item, isCompleted: item.status === 'completed' })),
    };
    res.status(200).json(enhancedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
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
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order || order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'الطلب ليس في حالة "معلق"' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
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
    await notifyUsers(io, usersToNotify, 'order_approved',
      `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', {
      orderId: id,
      status: 'approved',
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-approved.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
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
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order || order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
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
    await notifyUsers(io, usersToNotify, 'order_in_transit',
      `الطلب ${order.orderNumber} في حالة التوصيل`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    await emitSocketEvent(io, [order.branch.toString(), 'branch', 'admin'], 'orderStatusUpdated', {
      orderId: id,
      status: 'in_transit',
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-in-transit.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  } finally {
    session.endSession();
  }
};

// تأكيد التوصيل
const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order || order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'يجب أن يكون الطلب في حالة "في التوصيل" لتأكيد التوصيل' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
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
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
    await notifyUsers(io, usersToNotify, 'order_delivered',
      `تم توصيل الطلب ${order.orderNumber}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    await emitSocketEvent(io, [order.branch.toString(), 'branch', 'admin'], 'orderStatusUpdated', {
      orderId: id,
      status: 'delivered',
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-delivered.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  } finally {
    session.endSession();
  }
};

// إلغاء الطلب
const cancelOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الطلب غير صالح' });
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'سبب الإلغاء مطلوب ويجب أن يكون 5 أحرف على الأقل' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'errors.order_not_found' });
    }

    if (!['pending', 'approved'].includes(order.status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'لا يمكن إلغاء الطلب في هذه الحالة' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'branch') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
    }

    order.status = 'cancelled';
    order.cancelledAt = new Date();
    order.cancelReason = reason.trim();
    order.statusHistory.push({
      status: 'cancelled',
      changedBy: req.user.id,
      changedAt: new Date(),
      notes: reason.trim(),
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
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin', 'branch'] }, branchId: order.branch }).select('_id').lean();
    await notifyUsers(io, usersToNotify, 'order_cancelled',
      `تم إلغاء الطلب ${order.orderNumber} بسبب: ${reason}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin', 'branch'], 'orderStatusUpdated', {
      orderId: id,
      status: 'cancelled',
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-cancelled.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error cancelling order:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  } finally {
    session.endSession();
  }
};

// تحديث حالة عنصر الطلب
const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, taskId } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(taskId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الطلب أو العنصر غير صالح' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'حالة العنصر غير صالحة' });
    }

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'errors.order_not_found' });
    }

    const task = order.items.id(taskId);
    if (!task) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'errors.task_not_found' });
    }

    if (req.user.role === 'chef') {
      const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).select('_id').session(session);
      if (!chefProfile || task.assignedTo?.toString() !== req.user.id.toString()) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
      }
    } else if (req.user.role !== 'production' && req.user.role !== 'admin') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
    }

    if (!validateStatusTransition(task.status, status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_transition', errorDetails: `لا يمكن الانتقال من ${task.status} إلى ${status}` });
    }

    task.status = status;
    if (status === 'in_progress' && !task.startedAt) task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();

    const allItemsCompleted = order.items.every(item => item.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.completedAt = new Date();
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }

    order.markModified('items');
    await order.save({ session });

    const assignment = await ProductionAssignment.findOne({ order: orderId, itemId: taskId }).session(session);
    if (assignment) {
      assignment.status = status;
      if (status === 'in_progress') assignment.startedAt = new Date();
      if (status === 'completed') assignment.completedAt = new Date();
      await assignment.save({ session });
    }

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const productName = populatedOrder.items.find(item => item._id.toString() === taskId)?.product?.name || 'Unknown';
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin'] }, branchId: order.branch }).select('_id').lean();
    await notifyUsers(io, usersToNotify, 'task_status_updated',
      `تم تحديث حالة العنصر ${productName} في الطلب ${order.orderNumber} إلى ${status}`,
      { taskId, orderId, orderNumber: order.orderNumber, branchId: order.branch, productName }
    );

    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'taskStatusUpdated', {
      taskId,
      orderId,
      status,
      productName,
      chef: task.assignedTo ? { _id: task.assignedTo, username: populatedOrder.items.find(item => item._id.toString() === taskId)?.assignedTo?.username || 'Unknown' } : undefined,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/task-status-updated.mp3',
      vibrate: [200, 100, 200],
    });

    if (allItemsCompleted) {
      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم اكتمال الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
      await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderCompleted', {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'Unknown',
        sound: '/order-completed.mp3',
        vibrate: [200, 100, 200],
      });
    }

    await session.commitTransaction();
    res.status(200).json({
      task: {
        _id: taskId,
        status,
        order: populatedOrder,
        product: populatedOrder.items.find(item => item._id.toString() === taskId)?.product,
        chef: task.assignedTo ? { _id: task.assignedTo, username: populatedOrder.items.find(item => item._id.toString() === taskId)?.assignedTo?.username } : undefined,
        updatedAt: task.completedAt || task.startedAt || new Date(),
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  } finally {
    session.endSession();
  }
};

// تعيين الشيفات للعناصر
const assignChef = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId } = req.params;
    const { items } = req.body;

    if (!isValidObjectId(orderId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الطلب غير صالح' });
    }

    if (!Array.isArray(items) || !items.length || items.some(item => !isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo))) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'بيانات العناصر أو الشيفات غير صالحة' });
    }

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'errors.order_not_found' });
    }

    if (req.user.role !== 'production' && req.user.role !== 'admin') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
    }

    if (!['approved', 'in_production'].includes(order.status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.order_not_approved' });
    }

    const tasks = [];
    for (const item of items) {
      const orderItem = order.items.id(item.itemId);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'errors.task_not_found', errorDetails: `العنصر ${item.itemId} غير موجود` });
      }

      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo }).select('_id department').session(session);
      if (!chefProfile) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'errors.chef_not_found', errorDetails: `الشيف ${item.assignedTo} غير موجود` });
      }

      const product = await Product.findById(orderItem.product).select('department').lean().session(session);
      if (!product?.department) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'errors.no_department_assigned', errorDetails: `المنتج ${orderItem.product} غير مرتبط بقسم` });
      }

      if (req.user.role !== 'production' && chefProfile.department.toString() !== product.department.toString()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'errors.chef_department_mismatch', errorDetails: `الشيف ${item.assignedTo} لا ينتمي إلى قسم المنتج` });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      const newAssignment = new ProductionAssignment({
        order: orderId,
        product: orderItem.product,
        chef: chefProfile._id,
        quantity: orderItem.quantity,
        itemId: item.itemId,
        status: 'pending',
      });
      await newAssignment.save({ session });

      tasks.push({
        itemId: item.itemId,
        chef: item.assignedTo,
        status: 'assigned',
      });
    }

    order.status = order.items.every(item => item.status === 'assigned') ? 'in_production' : order.status;
    order.markModified('items');
    await order.save({ session });

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ _id: { $in: items.map(item => item.assignedTo) } }).select('_id').lean();
    for (const item of items) {
      const productName = populatedOrder.items.find(i => i._id.toString() === item.itemId)?.product?.name || 'Unknown';
      await notifyUsers(io, usersToNotify.filter(u => u._id.toString() === item.assignedTo), 'task_assigned',
        `تم تعيينك لإنتاج ${productName} في الطلب ${order.orderNumber}`,
        { taskId: item.itemId, orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
    }

    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'taskAssigned', {
      orderId,
      tasks: tasks.map(task => ({
        ...task,
        productName: populatedOrder.items.find(i => i._id.toString() === task.itemId)?.product?.name || 'Unknown',
      })),
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/task-assigned.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, tasks });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  } finally {
    session.endSession();
  }
};

// استرجاع المهام
const getTasks = async (req, res) => {
  try {
    const { status, departmentId } = req.query;

    if (departmentId && !isValidObjectId(departmentId)) {
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف القسم غير صالح' });
    }

    const query = { status: status || { $in: ['pending', 'in_progress', 'completed'] } };
    if (req.user.role === 'chef') {
      const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).select('_id').lean();
      if (!chefProfile) {
        return res.status(404).json({ success: false, message: 'errors.chef_not_found' });
      }
      query.chef = chefProfile._id;
    } else if (departmentId && req.user.role !== 'production') {
      const products = await Product.find({ department: departmentId }).select('_id').lean();
      query.product = { $in: products.map(p => p._id) };
    }

    const assignments = await ProductionAssignment.find(query)
      .populate({
        path: 'order',
        select: 'orderNumber branch',
        populate: { path: 'branch', select: 'name' },
      })
      .populate({ path: 'product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('chef')
      .lean();

    const tasks = assignments.map(assignment => ({
      _id: assignment._id,
      order: {
        _id: assignment.order?._id || 'unknown',
        orderNumber: assignment.order?.orderNumber || 'N/A',
        branch: assignment.order?.branch || { _id: 'unknown', name: 'Unknown' },
      },
      product: {
        _id: assignment.product?._id || 'unknown',
        name: assignment.product?.name || 'Unknown',
        department: assignment.product?.department || { _id: 'unknown', name: 'Unknown' },
      },
      chef: {
        _id: assignment.chef?._id || 'unknown',
        username: assignment.chef?.user?.username || 'Unknown',
      },
      quantity: assignment.quantity || 0,
      status: assignment.status || 'pending',
      itemId: assignment.itemId || 'unknown',
      createdAt: assignment.createdAt || new Date(),
      updatedAt: assignment.updatedAt || new Date(),
    }));

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  }
};

// مزامنة المهام
const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).session(session).lean();
    if (!order) return;

    const assignments = await ProductionAssignment.find({ order: orderId }).session(session).lean();
    const assignedItemIds = assignments.map(a => a.itemId.toString());

    const missingAssignments = order.items
      .filter(item => !assignedItemIds.includes(item._id.toString()) && item.status === 'pending')
      .map(item => ({
        itemId: item._id,
        productName: item.product?.name || 'Unknown',
      }));

    if (missingAssignments.length > 0) {
      const usersToNotify = await User.find({ role: 'production', branchId: order.branch }).select('_id').lean();
      for (const missing of missingAssignments) {
        await notifyUsers(io, usersToNotify, 'missing_assignments',
          `المنتج ${missing.productName} في الطلب ${order.orderNumber} يحتاج إلى تعيين`,
          { orderId, itemId: missing.itemId, productName: missing.productName, branchId: order.branch }
        );

        await emitSocketEvent(io, [order.branch.toString(), 'production'], 'missingAssignments', {
          orderId,
          itemId: missing.itemId,
          productName: missing.productName,
          branchId: order.branch,
          branchName: order.branch?.name || 'Unknown',
          sound: '/missing-assignments.mp3',
          vibrate: [200, 100, 200],
        });
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
  }
};

// Add to orderController.js
const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'errors.return_not_found' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'errors.invalid_request', errorDetails: 'حالة الإرجاع غير صالحة' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'errors.unauthorized_access' });
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();

    await returnRequest.save({ session });

    // Update inventory if approved
    if (status === 'approved') {
      for (const item of returnRequest.items) {
        const inventory = await Inventory.findOne({ product: item.product, branch: returnRequest.order.branch }).session(session);
        if (inventory) {
          inventory.currentStock += item.quantity;
          await inventory.save({ session });
        }
      }
    }

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name')
      .populate('reviewedBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'branch'] }, branchId: returnRequest.order.branch }).select('_id').lean();
    await notifyUsers(io, usersToNotify, 'return_status_updated',
      `تم تحديث حالة الإرجاع ${returnRequest._id} إلى ${status}`,
      { returnId: id, orderId: returnRequest.order._id, branchId: returnRequest.order.branch }
    );

    await emitSocketEvent(io, [returnRequest.order.branch.toString(), 'admin', 'production'], 'returnStatusUpdated', {
      returnId: id,
      status,
      orderId: returnRequest.order._id,
      orderNumber: populatedReturn.order?.orderNumber || 'Unknown',
      branchId: returnRequest.order.branch,
      branchName: populatedReturn.order?.branch?.name || 'Unknown',
      sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json(populatedReturn);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { status } = req.query;

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).select('_id').lean();
    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'errors.chef_not_found' });
    }

    const query = { chef: chefProfile._id };
    if (status) query.status = status;

    const assignments = await ProductionAssignment.find(query)
      .populate({
        path: 'order',
        select: 'orderNumber branch',
        populate: { path: 'branch', select: 'name' },
      })
      .populate({ path: 'product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('chef')
      .lean();

    const tasks = assignments.map(assignment => ({
      _id: assignment._id,
      order: {
        _id: assignment.order?._id || 'unknown',
        orderNumber: assignment.order?.orderNumber || 'N/A',
        branch: assignment.order?.branch || { _id: 'unknown', name: 'Unknown' },
      },
      product: {
        _id: assignment.product?._id || 'unknown',
        name: assignment.product?.name || 'Unknown',
        department: assignment.product?.department || { _id: 'unknown', name: 'Unknown' },
      },
      chef: {
        _id: assignment.chef?._id || 'unknown',
        username: assignment.chef?.user?.username || 'Unknown',
      },
      quantity: assignment.quantity || 0,
      status: assignment.status || 'pending',
      itemId: assignment.itemId || 'unknown',
      createdAt: assignment.createdAt || new Date(),
      updatedAt: assignment.updatedAt || new Date(),
    }));

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'errors.server_error', error: err.message });
  }
};

module.exports = {
  createOrderWithTasks,
  getOrders,
  getOrderById,
  approveOrder,
  startTransit,
  confirmDelivery,
  cancelOrder,
  updateTaskStatus,
  assignChef,
  getTasks,
  syncOrderTasks,
  approveReturn,
  updateOrderStatus,
  getChefTasks, // Add this line
};