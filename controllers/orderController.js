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
      if (!isValidObjectId(task.product) || !isValidObjectId(task.chef) || !task.quantity || !isValidObjectId(task.itemId)) continue;
      const orderItem = newOrder.items.id(task.itemId);
      if (!orderItem || orderItem.product.toString() !== task.product) continue;

      const chefProfile = await mongoose.model('Chef').findOne({ user: task.chef }).session(session);
      if (!chefProfile) continue;

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
        `تم تعيينك لإنتاج ${orderItem.product.name} للطلب ${orderNumber}`,
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

    const enhancedOrders = orders.map(order => ({
      ...order,
      items: order.items.map(item => ({ ...item, isCompleted: item.status === 'completed' })),
    }));

    res.status(200).json(enhancedOrders);
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const enhancedOrder = {
      ...order,
      items: order.items.map(item => ({ ...item, isCompleted: item.status === 'completed' })),
    };
    res.status(200).json(enhancedOrder);
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order || order.status !== 'pending') {
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order || order.status !== 'completed') {
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
      `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', {
      orderId: id,
      status: 'in_transit',
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-in-transit.mp3',
      vibrate: [300, 100, 300],
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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
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
      await notifyUsers(io, usersToNotify, 'order_status_updated',
        `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
      );
    }

    await emitSocketEvent(io, [order.branch.toString(), 'production', 'admin'], 'orderStatusUpdated', {
      orderId: id,
      status,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/status-updated.mp3',
      vibrate: [200, 100, 200],
    });

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
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch').session(session);
    if (!order || order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
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
    await notifyUsers(io, usersToNotify, 'order_delivered',
      `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${order.branch?.name || 'Unknown'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch?._id }
    );

    await emitSocketEvent(io, [order.branch?._id.toString(), 'production', 'admin'], 'orderStatusUpdated', {
      orderId: id,
      status: 'delivered',
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
      sound: '/order-delivered.mp3',
      vibrate: [300, 100, 300],
    });

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

    if (!isValidObjectId(id) || !['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الإرجاع أو الحالة غير صالحة' });
    }

    const returnRequest = await Return.findById(id).populate('order').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع' });
    }

    if (status === 'approved') {
      const order = await Order.findById(returnRequest.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }

      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          await session.abortTransaction();
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
    await notifyUsers(io, usersToNotify, 'return_status_updated',
      `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order?.orderNumber || 'Unknown'}`,
      { returnId: id, orderId: returnRequest.order?._id, orderNumber: returnRequest.order?.orderNumber }
    );

    await emitSocketEvent(io, [returnRequest.order?.branch.toString(), 'admin', 'production'], 'returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
      sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
      vibrate: [200, 100, 200],
    });

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

// استرجاع المهام
const getTasks = async (req, res) => {
  try {
    const { orderId, status } = req.query;
    const query = {};
    if (orderId && isValidObjectId(orderId)) query.order = orderId;
    if (status) query.status = status;

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name price unit department')
      .populate('chef', 'username')
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// استرجاع مهام الشيف
const getChefTasks = async (req, res) => {
  try {
    const { status } = req.query;
    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).lean();
    if (!chefProfile) {
      return res.status(404).json({ success: false, message: 'ملف الشيف غير موجود' });
    }

    const query = { chef: chefProfile._id };
    if (status) query.status = status;

    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name price unit department')
      .populate('chef', 'username')
      .lean();

    res.status(200).json(tasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// تحديث حالة المهمة
const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id) || !['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المهمة أو الحالة غير صالحة' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'ملف الشيف غير موجود' });
    }

    const task = await ProductionAssignment.findOne({ _id: id, chef: chefProfile._id }).session(session);
    if (!task) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة أو غير معينة لك' });
    }

    task.status = status;
    if (status === 'in_progress' && !task.startedAt) task.startedAt = new Date();
    if (status === 'completed' && !task.completedAt) task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(task.order).session(session);
    if (order) {
      const orderItem = order.items.id(task.itemId);
      if (orderItem) {
        orderItem.status = status;
        if (status === 'in_progress') orderItem.startedAt = task.startedAt;
        if (status === 'completed') orderItem.completedAt = task.completedAt;
        order.markModified('items');
        await order.save({ session });
      }
    }

    await syncOrderTasks(task.order, req.app.get('io'), session);

    const populatedTask = await ProductionAssignment.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name price unit department')
      .populate('chef', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    await emitSocketEvent(io, [`chef-${chefProfile.user}`, `branch-${order?.branch}`, 'production', 'admin'], 'taskStatusUpdated', {
      taskId: id,
      status,
      orderId: task.order,
      orderNumber: populatedTask.order?.orderNumber,
      branchId: order?.branch,
      productName: populatedTask.product?.name || 'Unknown',
      sound: '/task-status-updated.mp3',
      vibrate: [200, 100, 200],
    });

    await session.commitTransaction();
    res.status(200).json(populatedTask);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// مزامنة المهام مع الطلب
const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    const [order, tasks] = await Promise.all([
      Order.findById(orderId).populate('items.product').session(session),
      ProductionAssignment.find({ order: orderId }).lean(),
    ]);

    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    const taskItemIds = new Set(tasks.map(t => t.itemId?.toString()).filter(Boolean));
    const missingItems = order.items.filter(item => !taskItemIds.has(item._id?.toString()) && item._id);

    if (missingItems.length > 0) {
      await emitSocketEvent(io, ['production', 'admin', `branch-${order.branch}`], 'missingAssignments', missingItems.map(item => ({
        orderId,
        itemId: item._id,
        productId: item.product?._id,
        productName: item.product?.name || 'Unknown',
      })));
    }

    let hasIncompleteItems = false;
    for (const task of tasks) {
      const orderItem = order.items.id(task.itemId);
      if (orderItem) {
        if (task.status !== orderItem.status) {
          orderItem.status = task.status;
          if (task.status === 'in_progress') orderItem.startedAt = task.startedAt || new Date();
          if (task.status === 'completed') orderItem.completedAt = task.completedAt || new Date();
        }
        if (task.status !== 'completed') hasIncompleteItems = true;
      }
    }

    for (const item of order.items) {
      if (!taskItemIds.has(item._id.toString()) && item.status !== 'completed') {
        hasIncompleteItems = true;
      }
    }

    const allTasksCompleted = tasks.every(t => t.status === 'completed');
    const allOrderItemsCompleted = order.items.every(i => i.status === 'completed');

    if (allTasksCompleted && allOrderItemsCompleted && !['completed', 'in_transit', 'delivered'].includes(order.status)) {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date(),
      });

      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ role: { $in: ['branch', 'admin', 'production'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم اكتمال الطلب ${order.orderNumber} لفرع ${branch?.name || 'Unknown'}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName: branch?.name || 'Unknown' }
      );

      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300],
      });
    }

    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in syncOrderTasks:`, err);
    throw err;
  }
};

module.exports = {
  createOrderWithTasks,
  getOrders,
  getOrderById,
  approveOrder,
  startTransit,
  updateOrderStatus,
  confirmDelivery,
  approveReturn,
  getTasks,
  getChefTasks,
  updateTaskStatus,
};