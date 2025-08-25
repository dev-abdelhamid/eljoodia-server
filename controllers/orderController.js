const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { createNotification, notifyUsers, emitSocketEvent, getUsersToNotify } = require('../utils/notifications');
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

const checkOrderExists = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] معرف الطلب غير صالح في checkOrderExists: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] الطلب غير موجود في checkOrderExists: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] محاولة وصول غير مخولة للفرع في checkOrderExists:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في التحقق من وجود الطلب:`, err);
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
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] معرف الفرع غير صالح:`, { branch, user: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] رقم الطلب أو العناصر مفقودة:`, { orderNumber, items });
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
    const usersToNotify = await getUsersToNotify(['admin', 'production', 'branch'], branch);
    await notifyUsers(io, usersToNotify, 'new_order_from_branch',
      `طلب جديد ${orderNumber} تم إنشاؤه بواسطة الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      { orderId: newOrder._id, orderNumber, branchId: branch }
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'newOrderFromBranch', {
      ...populatedOrder,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
    });

    await session.commitTransaction();
    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء الطلب:`, err);
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
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] معرف الطلب أو العناصر غير صالحة:`, { orderId, items });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] الطلب غير موجود: ${orderId}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] محاولة وصول غير مخولة للفرع:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] حالة الطلب غير صالحة لتعيين الشيفات: ${order.status}`);
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

      assignments.push(ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId },
        { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
        { upsert: true, session }
      ));

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
      });
    }

    await Promise.all(assignments);

    const usersToNotify = await getUsersToNotify(['admin', 'production', 'branch'], order.branch?._id, { _id: { $in: items.map(i => i.assignedTo) } });
    await notifyUsers(io, usersToNotify, 'new_production_assigned_to_chef',
      `تم تعيينك لإنتاج عنصر في الطلب ${order.orderNumber}`,
      { orderId, orderNumber: order.orderNumber, branchId: order.branch?._id }
    );

    order.markModified('items');
    await order.save({ session });
    await syncOrderTasks(orderId, io, session);

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .lean();

    await Promise.all(taskAssignedEvents.map(event => 
      emitSocketEvent(io, [
        `chef-${event.chefId}`,
        `branch-${order.branch?._id}`,
        'production',
        'admin',
      ], 'newProductionAssignedToChef', event)
    ));

    await emitSocketEvent(io, [order.branch?._id.toString(), 'production', 'admin'], 'orderUpdated', {
      ...populatedOrder,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'غير معروف',
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تعيين الشيفات:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    console.log(`[${new Date().toISOString()}] جارٍ استرجاع الطلبات بالاستعلام:`, { query, userId: req.user.id, role: req.user.role });

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`[${new Date().toISOString()}] تم العثور على ${orders.length} طلب`);

    orders.forEach(order => order.items.forEach(item => item.isCompleted = item.status === 'completed'));

    res.status(200).json(orders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع الطلبات:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] معرف الطلب غير صالح: ${id}, المستخدم:`, { userId: req.user.id, role: req.user.role });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    console.log(`[${new Date().toISOString()}] جارٍ استرجاع الطلب بالمعرف: ${id}, المستخدم:`, { userId: req.user.id, role: req.user.role });

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] الطلب غير موجود: ${id}, المستخدم:`, { userId: req.user.id, role: req.user.role });
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] محاولة وصول غير مخولة للفرع:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    order.items.forEach(item => item.isCompleted = item.status === 'completed');
    console.log(`[${new Date().toISOString()}] تم استرجاع الطلب بنجاح: ${id}`);
    res.status(200).json(order);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع الطلب بالمعرف:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] معرف الطلب غير صالح: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] الطلب غير موجود: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] حالة الطلب غير صالحة للاعتماد: ${order.status}`);
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] محاولة اعتماد غير مخولة:`, { userId: req.user.id, role: req.user.role });
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
    const usersToNotify = await getUsersToNotify(['admin', 'production', 'branch'], order.branch);
    await notifyUsers(io, usersToNotify, 'order_approved_for_branch',
      `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApprovedForBranch', {
      orderId: id,
      status: 'approved',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في اعتماد الطلب:`, err);
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
      console.error(`[${new Date().toISOString()}] معرف الطلب غير صالح: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] الطلب غير موجود: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] حالة الطلب غير صالحة للتوصيل: ${order.status}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' });
    }

    if (req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] محاولة توصيل غير مخولة:`, { userId: req.user.id, role: req.user.role });
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
    const usersToNotify = await getUsersToNotify(['admin', 'production', 'branch'], order.branch);
    await notifyUsers(io, usersToNotify, 'order_in_transit_to_branch',
      `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransitToBranch', {
      orderId: id,
      status: 'in_transit',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في بدء التوصيل:`, err);
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
      console.error(`[${new Date().toISOString()}] معرف الطلب غير صالح: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] الطلب غير موجود: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] انتقال حالة غير صالح:`, { current: order.status, new: status });
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

    const io = req.app.get('io');
    const notifyRoles = {
      approved: ['production', 'branch'],
      in_production: ['chef', 'branch', 'admin'],
      in_transit: ['branch', 'admin'],
      cancelled: ['branch', 'production', 'admin'],
      delivered: ['branch', 'admin'],
      completed: ['production', 'admin'],
    }[status] || [];

    if (notifyRoles.length) {
      const usersToNotify = await getUsersToNotify(notifyRoles, order.branch);
      await notifyUsers(io, usersToNotify, status === 'completed' ? 'order_completed_by_chefs' : 'order_status_updated',
        `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
      );
    }

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', {
      orderId: id,
      status,
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'غير معروف',
    });

    if (status === 'completed') {
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompletedByChefs', {
        orderId: id,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: populatedOrder.branch?.name || 'غير معروف',
        completedAt: new Date().toISOString(),
      });
    }

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تحديث حالة الطلب:`, err);
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
      console.error(`[${new Date().toISOString()}] معرف الطلب غير صالح: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch').session(session);
    if (!order || order.status !== 'in_transit') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] حالة الطلب غير صالحة للتسليم:`, { status: order?.status, orderId: id });
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] محاولة وصول غير مخولة للفرع:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id });
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
    const usersToNotify = await getUsersToNotify(['admin', 'production', 'branch'], order.branch);
    await notifyUsers(io, usersToNotify, 'branch_confirmed_receipt',
      `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${order.branch?.name || 'غير معروف'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch?._id }
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch?._id}`], 'branchConfirmedReceipt', {
      orderId: id,
      status: 'delivered',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'غير معروف',
      deliveredAt: new Date().toISOString(),
    });

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تأكيد التسليم:`, err);
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
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] معرف الإرجاع غير صالح: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(id).populate('order').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] الإرجاع غير موجود: ${id}`);
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] حالة الإرجاع غير صالحة: ${status}`);
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] محاولة موافقة على الإرجاع غير مخولة:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع' });
    }

    if (status === 'approved') {
      const order = await Order.findById(returnRequest.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] الطلب غير موجود للإرجاع: ${returnRequest.order._id}`);
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }

      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] عنصر الطلب غير موجود للإرجاع: ${returnItem.itemId}`);
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
    const usersToNotify = await getUsersToNotify(['admin', 'production', 'branch'], returnRequest.order?.branch);
    await notifyUsers(io, usersToNotify, 'return_status_updated',
      `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order?.orderNumber || 'غير معروف'}`,
      { returnId: id, orderId: returnRequest.order?._id, orderNumber: returnRequest.order?.orderNumber }
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.order?.branch}`], 'returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
    });

    await session.commitTransaction();
    res.status(200).json(returnRequest);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في الموافقة على الإرجاع:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createOrder,
  assignChefs,
  getOrders,
  getOrderById,
  checkOrderExists,
  approveOrder,
  startTransit,
  updateOrderStatus,
  confirmDelivery,
  approveReturn,
};