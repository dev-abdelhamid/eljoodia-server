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
    cancelled: []
  };
  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderNumber, items, status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة' });
    }

    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product)) throw new Error(`معرف المنتج غير صالح: ${item.product}`);
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) existing.quantity += item.quantity;
      else acc.push(item);
      return acc;
    }, []);

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending'
      })),
      status,
      notes: notes?.trim(),
      priority,
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0)
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
      vibrate: [300, 100, 300]
    };
    io.of('/api').to(branch.toString()).emit('orderCreated', orderData);
    io.of('/api').to('production').emit('orderCreated', orderData);
    io.of('/api').to('admin').emit('orderCreated', orderData);

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

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });
    }

    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })
      .populate('branch')
      .session(session)
      .lean();
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const io = req.app.get('io');
    const updatedOrder = await Order.findById(orderId).session(session);

    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرفات غير صالحة' });
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود` });
      }

      const chef = await User.findById(item.assignedTo).populate('department').lean();
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo }).session(session).lean();
      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department?._id.toString() !== orderItem.product.department?._id.toString()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع القسم' });
      }

      const targetItem = updatedOrder.items.id(itemId);
      if (!targetItem) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود` });
      }

      targetItem.assignedTo = item.assignedTo;
      targetItem.status = 'assigned';
      targetItem.department = orderItem.product.department;

      await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId },
        { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId },
        { upsert: true, session }
      );

      await createNotification(
        item.assignedTo,
        'task_assigned',
        `تم تعيينك لإنتاج ${orderItem.product.name} للطلب ${order.orderNumber}`,
        { taskId: targetItem._id, orderId, orderNumber: order.orderNumber, branchId: order.branch?._id },
        io
      );

      io.of('/api').to(`chef-${item.assignedTo}`).emit('taskAssigned', {
        _id: targetItem._id,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: orderItem.product._id, name: orderItem.product.name },
        chef: { _id: item.assignedTo, username: chef.name || 'Unknown' },
        quantity: orderItem.quantity,
        itemId,
        status: 'pending',
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
        sound: '/task-assigned.mp3',
        vibrate: [400, 100, 400]
      });
    }

    updatedOrder.markModified('items');
    await updatedOrder.save({ session });

    await syncOrderTasks(orderId, io, session);

    await session.commitTransaction();

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
      vibrate: [200, 100, 200]
    };
    io.of('/api').to(order.branch?._id.toString()).emit('orderUpdated', orderData);
    io.of('/api').to('production').emit('orderUpdated', orderData);
    io.of('/api').to('admin').emit('orderUpdated', orderData);

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
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
      cancelled: ['branch', 'production', 'admin']
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
      vibrate: [200, 100, 200]
    };
    io.of('/api').to(order.branch.toString()).emit('orderStatusUpdated', orderData);
    io.of('/api').to('production').emit('orderStatusUpdated', orderData);
    io.of('/api').to('admin').emit('orderStatusUpdated', orderData);

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

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch').session(session).lean();
    if (!order || order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const updatedOrder = await Order.findById(id).session(session);
    for (const item of updatedOrder.items) {
      await Inventory.findOneAndUpdate(
        { branch: updatedOrder.branch, product: item.product },
        { $inc: { currentStock: item.quantity } },
        { upsert: true, session }
      );
    }

    updatedOrder.status = 'delivered';
    updatedOrder.deliveredAt = new Date();
    updatedOrder.statusHistory.push({ status: 'delivered', changedBy: req.user.id });
    await updatedOrder.save({ session });

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] }, branchId: order.branch?._id }).select('_id').lean();
    const io = req.app.get('io');
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
      sound: '/order-delivered.mp3',
      vibrate: [300, 100, 300]
    };
    io.of('/api').to(order.branch?._id.toString()).emit('orderStatusUpdated', orderData);
    io.of('/api').to('production').emit('orderStatusUpdated', orderData);
    io.of('/api').to('admin').emit('orderStatusUpdated', orderData);

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

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(id).populate('order').session(session).lean();
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    const updatedReturn = await Return.findById(id).session(session);
    if (status === 'approved') {
      for (const item of updatedReturn.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: item.product },
          { $inc: { currentStock: -item.quantity } },
          { upsert: true, session }
        );
      }
    }

    updatedReturn.status = status;
    if (reviewNotes) updatedReturn.reviewNotes = reviewNotes.trim();
    await updatedReturn.save({ session });

    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order?.branch }).select('_id').lean();
    const io = req.app.get('io');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order?.orderNumber || 'Unknown'}`,
        { returnId: id, orderId: returnRequest.order?._id, orderNumber: returnRequest.order?.orderNumber },
        io
      );
    }

    io.of('/api').to(returnRequest.order?.branch.toString()).emit('returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
      sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
      vibrate: [200, 100, 200]
    });
    io.of('/api').to('admin').emit('returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
      sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
      vibrate: [200, 100, 200]
    });

    await session.commitTransaction();
    res.status(200).json(updatedReturn);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createOrder, assignChefs, getOrders, updateOrderStatus, confirmDelivery, approveReturn };
