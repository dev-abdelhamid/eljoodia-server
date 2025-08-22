const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');

// التحقق من معرف MongoDB صالح
const isValidObjectId = mongoose.isValidObjectId;

// التحقق من صحة انتقال الحالة
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

// دالة مساعدة لإصدار الأحداث
const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const uniqueRooms = [...new Set(rooms.filter(room => room))];
  uniqueRooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName} to rooms: ${uniqueRooms.join(', ')}`, {
    eventData: { ...eventData, sound: eventData.sound, vibrate: eventData.vibrate }
  });
};

// دالة مساعدة لإرسال إشعارات إلى المستخدمين
const notifyUsers = async (io, users, type, message, data, departmentId = null) => {
  for (const user of users) {
    await createNotification(user._id, type, message, data, io, departmentId);
  }
};

// إنشاء طلب
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

    // التحقق من صحة معرفات المنتجات مبكرًا
    const invalidProducts = items.filter(item => !isValidObjectId(item.product));
    if (invalidProducts.length) {
      throw new Error(`معرفات منتجات غير صالحة: ${invalidProducts.map(i => i.product).join(', ')}`);
    }

    // دمج العناصر المتكررة
    const mergedItems = items.reduce((acc, item) => {
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

    // جلب بيانات القسم للعناصر
    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('name price unit department')
      .populate('department', 'name code')
      .lean();

    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin'] }, branchId: branch })
      .select('_id department')
      .lean();

    // إرسال إشعارات إلى المستخدمين مع دعم القسم
    const departments = [...new Set(products.map(p => p.department?._id).filter(Boolean))];
    await notifyUsers(
      io,
      usersToNotify,
      'order_created',
      `طلب جديد ${orderNumber} تم إنشاؤه بواسطة الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
      { orderId: newOrder._id, orderNumber, branchId: branch },
      null
    );

    const orderData = {
      ...populatedOrder,
      branchId: branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      sound: '/order-created.mp3',
      vibrate: [300, 100, 300],
    };
    const rooms = [branch.toString(), 'production', 'admin', ...departments.map(d => `department-${d}`)];
    await emitSocketEvent(io, rooms, 'orderCreated', orderData);

    await session.commitTransaction();
    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, err);
    res.status(err.message.includes('معرف') ? 400 : 500).json({ success: false, message: err.message });
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

    if (!['approved', 'in_production'].includes(order.status)) {
      throw new Error('يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات');
    }

    const io = req.app.get('io');
    const chefIds = items.map(item => item.assignedTo).filter(Boolean);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' })
      .populate('department')
      .lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();

    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error('معرفات العنصر أو الشيف غير صالحة');
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(`العنصر ${itemId} غير موجود`);
      }

      const existingTask = await ProductionAssignment.findOne({ order: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        throw new Error('لا يمكن إعادة تعيين المهمة لشيف آخر');
      }

      const chef = chefs.find(c => c._id.toString() === item.assignedTo);
      const chefProfile = chefProfiles.find(c => c.user.toString() === item.assignedTo);
      if (!chef || !chefProfile || chef.department?._id.toString() !== orderItem.product.department?._id.toString()) {
        throw new Error('الشيف غير صالح أو غير متطابق مع القسم');
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      orderItem.department = orderItem.product.department;

      await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId },
        { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
        { upsert: true, session }
      );

      const taskAssignedEvent = {
        _id: itemId,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: orderItem.product._id, name: orderItem.product.name, department: orderItem.product.department },
        chef: { _id: item.assignedTo, username: chef.name || 'Unknown' },
        quantity: orderItem.quantity,
        itemId,
        status: 'pending',
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        sound: '/notification.mp3',
        vibrate: [400, 100, 400],
      };
      const rooms = [
        `chef-${item.assignedTo}`,
        `branch-${order.branch?._id}`,
        'production',
        'admin',
        `department-${orderItem.product.department?._id}`
      ];
      await emitSocketEvent(io, rooms, 'taskAssigned', taskAssignedEvent);

      await notifyUsers(
        io,
        [{ _id: item.assignedTo }],
        'task_assigned',
        `تم تعيينك لإنتاج ${orderItem.product.name} للطلب ${order.orderNumber}`,
        { taskId: itemId, orderId, orderNumber: order.orderNumber, branchId: order.branch?._id },
        orderItem.product.department?._id
      );

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
      await emitSocketEvent(io, rooms, 'itemStatusUpdated', itemStatusEvent);
    }

    if (order.items.some(item => item.status === 'assigned') && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
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
    await emitSocketEvent(io, [`branch-${order.branch?._id}`, 'production', 'admin', ...order.items.map(item => `department-${item.product.department?._id}`)], 'orderUpdated', orderData);

    if (order.status === 'in_production') {
      const orderStatusEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        sound: '/status-updated.mp3',
        vibrate: [200, 100, 200],
      };
      await emitSocketEvent(io, [`branch-${order.branch?._id}`, 'production', 'admin', ...order.items.map(item => `department-${item.product.department?._id}`)], 'orderStatusUpdated', orderStatusEvent);
    }

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مخول') ? 400 : 500).json({ success: false, message: err.message });
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

    res.status(200).json(orders.map(order => ({
      ...order,
      items: order.items.map(item => ({ ...item, isCompleted: item.status === 'completed' })),
    })));
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
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لهذا الفرع');
    }

    res.status(200).json({
      ...order,
      items: order.items.map(item => ({ ...item, isCompleted: item.status === 'completed' })),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, err);
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مخول') ? 400 : 500).json({ success: false, message: err.message });
  }
};

// اعتماد الطلب
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

    if (!['admin', 'production'].includes(req.user.role)) {
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
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin'] }, branchId: order.branch })
      .select('_id department')
      .lean();

    await notifyUsers(
      io,
      usersToNotify,
      'order_approved',
      `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
      null
    );

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
    const rooms = [order.branch.toString(), 'production', 'admin', ...populatedOrder.items.map(item => `department-${item.product.department?._id}`)];
    await emitSocketEvent(io, rooms, 'orderStatusUpdated', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, err);
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مخول') ? 400 : 500).json({ success: false, message: err.message });
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
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: order.branch })
      .select('_id department')
      .lean();

    await notifyUsers(
      io,
      usersToNotify,
      'order_in_transit',
      `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'Unknown'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
      null
    );

    const orderData = {
      orderId: id,
      status: 'in_transit',
      user: req.user,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
      transitStartedAt: new Date().toISOString(),
      sound: '/order-in-transit.mp3',
      vibrate: [300, 100, 300],
    };
    const rooms = [order.branch.toString(), 'production', 'admin', ...populatedOrder.items.map(item => `department-${item.product.department?._id}`)];
    await emitSocketEvent(io, rooms, 'orderStatusUpdated', orderData);
    await emitSocketEvent(io, rooms, 'orderInTransit', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, err);
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مخول') ? 400 : 500).json({ success: false, message: err.message });
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
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    if (!validateStatusTransition(order.status, status)) {
      throw new Error(`الانتقال من ${order.status} إلى ${status} غير مسموح`);
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
      approved: ['production'],
      in_production: ['chef', 'branch'],
      in_transit: ['branch', 'admin'],
      cancelled: ['branch', 'production', 'admin'],
      delivered: ['branch', 'admin'],
      completed: ['branch', 'admin'],
    }[status] || [];

    if (notifyRoles.length) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch })
        .select('_id department')
        .lean();
      await notifyUsers(
        io,
        usersToNotify,
        'order_status_updated',
        `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch },
        null
      );
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
    const rooms = [order.branch.toString(), 'production', 'admin', ...populatedOrder.items.map(item => `department-${item.product.department?._id}`)];
    await emitSocketEvent(io, rooms, 'orderStatusUpdated', orderData);

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
      await emitSocketEvent(io, rooms, 'orderCompleted', completedEventData);
    }

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, err);
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مسموح') ? 400 : 500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
};

// تحديث حالة العنصر
const updateItemStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, itemId } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(itemId)) {
      throw new Error('معرف الطلب أو العنصر غير صالح');
    }

    if (!['pending', 'assigned', 'in_progress', 'completed'].includes(status)) {
      throw new Error('حالة العنصر غير صالحة');
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('branch', 'name')
      .session(session);
    if (!order) {
      throw new Error('الطلب غير موجود');
    }

    const orderItem = order.items.find(i => i._id.toString() === itemId);
    if (!orderItem) {
      throw new Error('العنصر غير موجود');
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لهذا الفرع');
    }

    if (req.user.role === 'chef' && (!orderItem.assignedTo || orderItem.assignedTo.toString() !== req.user.id)) {
      throw new Error('غير مخول لتحديث هذا العنصر');
    }

    orderItem.status = status;
    if (status === 'in_progress') {
      orderItem.startedAt = new Date();
    } else if (status === 'completed') {
      orderItem.completedAt = new Date();
    }

    if (order.items.every(item => item.status === 'completed') && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    } else if (order.items.some(item => ['in_progress', 'completed'].includes(item.status)) && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, req.app.get('io'), session);

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['production', 'admin'] }, branchId: order.branch })
      .select('_id department')
      .lean();

    await notifyUsers(
      io,
      usersToNotify,
      'item_status_updated',
      `تم تحديث حالة العنصر ${orderItem.product.name} في الطلب ${order.orderNumber} إلى ${status}`,
      { orderId, itemId, orderNumber: order.orderNumber, branchId: order.branch?._id },
      orderItem.product.department?._id
    );

    const itemStatusEvent = {
      orderId,
      itemId,
      status,
      productName: orderItem.product.name,
      orderNumber: order.orderNumber,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
      sound: '/status-updated.mp3',
      vibrate: [200, 100, 200],
    };
    const rooms = [
      `branch-${order.branch?._id}`,
      'production',
      'admin',
      `department-${orderItem.product.department?._id}`,
    ];
    await emitSocketEvent(io, rooms, 'itemStatusUpdated', itemStatusEvent);

    if (order.status === 'completed') {
      const completedEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300],
      };
      await emitSocketEvent(io, rooms, 'orderCompleted', completedEventData);
    }

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating item status:`, err);
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مخول') ? 400 : 500).json({ success: false, message: err.message });
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
      throw new Error('معرف الطلب غير صالح');
    }

    const order = await Order.findById(id).populate('items.product').populate('branch').session(session);
    if (!order || order.status !== 'in_transit') {
      throw new Error('الطلب يجب أن يكون قيد التوصيل');
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      throw new Error('غير مخول لهذا الفرع');
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
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] }, branchId: order.branch?._id })
      .select('_id department')
      .lean();

    await notifyUsers(
      io,
      usersToNotify,
      'order_delivered',
      `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${order.branch?.name || 'Unknown'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch?._id },
      null
    );

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
    const rooms = [order.branch?._id.toString(), 'production', 'admin', ...populatedOrder.items.map(item => `department-${item.product.department?._id}`)];
    await emitSocketEvent(io, rooms, 'orderStatusUpdated', orderData);
    await emitSocketEvent(io, rooms, 'orderDelivered', orderData);

    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err);
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مخول') ? 400 : 500).json({ success: false, message: err.message });
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
      throw new Error('معرف الإرجاع غير صالح');
    }

    if (!['approved', 'rejected'].includes(status)) {
      throw new Error('حالة غير صالحة');
    }

    if (!['admin', 'production'].includes(req.user.role)) {
      throw new Error('غير مخول للموافقة على الإرجاع');
    }

    const returnRequest = await Return.findById(id).populate('order').session(session);
    if (!returnRequest) {
      throw new Error('الإرجاع غير موجود');
    }

    if (status === 'approved') {
      const order = await Order.findById(returnRequest.order._id).session(session);
      if (!order) {
        throw new Error('الطلب غير موجود');
      }

      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          throw new Error(`العنصر ${returnItem.itemId} غير موجود في الطلب`);
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
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order?.branch })
      .select('_id department')
      .lean();

    await notifyUsers(
      io,
      usersToNotify,
      'return_status_updated',
      `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order?.orderNumber || 'Unknown'}`,
      { returnId: id, orderId: returnRequest.order?._id, orderNumber: returnRequest.order?.orderNumber },
      null
    );

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
    res.status(err.message.includes('معرف') || err.message.includes('غير موجود') || err.message.includes('غير مخول') ? 400 : 500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createOrder,
  assignChefs,
  getOrders,
  getOrderById,
  approveOrder,
  startTransit,
  updateOrderStatus,
  confirmDelivery,
  approveReturn,
  updateItemStatus
};