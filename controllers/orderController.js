const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const Notification = require('../models/Notification');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['cancelled', 'completed'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
};

const createNotification = async (to, type, message, data, io) => {
  const notification = new Notification({
    user: to,
    type,
    message,
    data,
    read: false,
  });
  await notification.save();
  io.to(`user-${to}`).emit('newNotification', notification);
  console.log(`Notification sent to user-${to} at ${new Date().toISOString()}:`, { type, message });
  return notification;
};

const createOrder = async (req, res) => {
  try {
    const { orderNumber, items, status, notes, priority, branchId } = req.body;
    let branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة' });
    }

    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find((i) => i.product.toString() === item.product.toString());
      if (existing) existing.quantity += item.quantity;
      else acc.push(item);
      return acc;
    }, []);

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map((item) => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending'
      })),
      status: 'pending',
      notes: notes?.trim(),
      priority: priority || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
    });

    await newOrder.save();

    const io = req.app.get('io');
    for (const item of newOrder.items) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({ success: false, message: `المنتج ${item.product} غير موجود` });
      }
      const chef = await mongoose.model('Chef').findOne({ department: product.department });
      if (chef) {
        const assignment = await ProductionAssignment.create({
          order: newOrder._id,
          product: item.product,
          chef: chef._id,
          quantity: item.quantity,
          itemId: item._id,
          status: 'pending'
        });
        item.assignedTo = chef.user;
        item.status = 'assigned';
        await createNotification(
          chef.user,
          'task_assigned',
          `تم تعيينك لإنتاج ${product.name} في الطلب ${orderNumber}`,
          { taskId: assignment._id, orderId: newOrder._id },
          io
        );
        io.to(`chef-${chef.user}`).emit('taskAssigned', {
          _id: assignment._id,
          order: { _id: newOrder._id, orderNumber },
          product: { _id: product._id, name: product.name },
          chef: { _id: chef.user, username: chef.user.username || 'Unknown' },
          quantity: item.quantity,
          itemId: item._id,
          status: 'pending'
        });
      }
    }
    await newOrder.save();

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    const notifyRoles = ['production', 'admin'];
    const usersToNotify = await User.find({ role: { $in: notifyRoles } }).select('_id');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_created',
        `طلب جديد ${orderNumber} تم إنشاؤه بواسطة الفرع ${populatedOrder.branch.name}`,
        { orderId: newOrder._id },
        io
      );
    }

    io.to(branch.toString()).emit('orderCreated', populatedOrder);
    io.to('production').emit('orderCreated', populatedOrder);
    res.status(201).json(populatedOrder);
  } catch (err) {
    console.error(`Error creating order at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const assignChefs = async (req, res) => {
  try {
    const { items } = req.body;
    const { id: orderId } = req.params;

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    if (!items?.length) {
      return res.status(400).json({ success: false, message: 'مصفوفة العناصر مطلوبة' });
    }

    const order = await Order.findById(orderId)
      .populate({
        path: 'items.product',
        populate: { path: 'department', select: 'name code isActive' },
      })
      .populate('branch');
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const io = req.app.get('io');
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        return res.status(400).json({ success: false, message: 'معرفات غير صالحة' });
      }

      const orderItem = order.items.id(item.itemId);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في الطلب` });
      }

      const chef = await User.findById(item.assignedTo).populate('department');
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo });
      const product = orderItem.product;

      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department._id.toString() !== product.department._id.toString()) {
        return res.status(400).json({ success: false, message: `الشيف ${chef?.name || item.assignedTo} غير صالح أو غير متطابق مع القسم` });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      orderItem.department = product.department;

      const assignment = await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId: item.itemId },
        { chef: chefProfile._id, product: product._id, quantity: orderItem.quantity, status: 'pending' },
        { upsert: true, new: true }
      );

      await createNotification(
        item.assignedTo,
        'task_assigned',
        `تم تعيينك لإنتاج ${product.name} في الطلب ${order.orderNumber}`,
        { taskId: assignment._id, orderId },
        io
      );
      io.to(`chef-${item.assignedTo}`).emit('taskAssigned', {
        _id: assignment._id,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: product._id, name: product.name },
        chef: { _id: item.assignedTo, username: chef.name },
        quantity: orderItem.quantity,
        itemId: item.itemId,
        status: 'pending'
      });
    }

    await order.save();

    // إزالة تحديث حالة الطلب إلى 'in_production' تلقائيًا
    // order.status = order.items.every((i) => i.status === 'assigned') ? 'in_production' : order.status;
    // if (order.isModified('status')) {
    //   order.statusHistory.push({ status: order.status, changedBy: req.user.id });
    //   await order.save();
    //
    //   const usersToNotify = await User.find({ role: { $in: ['chef', 'admin'] } }).select('_id');
    //   for (const user of usersToNotify) {
    //     await createNotification(
    //       user._id,
    //       'order_status_updated',
    //       `بدأ إنتاج الطلب ${order.orderNumber}`,
    //       { orderId },
    //       io
    //     );
    //   }
    // }

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .lean();

    io.to(order.branch.toString()).emit('orderUpdated', populatedOrder);
    io.to('production').emit('orderUpdated', populatedOrder);
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error assigning chefs at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// باقي الدوال بدون تغيير
const getOrders = async (req, res) => {
  try {
    const { status, branch } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    orders.forEach((order) => {
      order.items.forEach((item) => {
        item.isCompleted = item.status === 'completed';
      });
    });

    res.status(200).json(orders);
  } catch (err) {
    console.error(`Error fetching orders at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (!validateStatusTransition(order.status, status)) {
      return res.status(400).json({ success: false, message: `الانتقال من ${order.status} إلى ${status} غير مسموح` });
    }

    order.status = status;
    if (notes) order.notes = notes.trim();
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes,
      changedAt: new Date(),
    });
    await order.save();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    let notifyRoles = [];
    if (status === 'approved') notifyRoles = ['production'];
    if (status === 'in_production') notifyRoles = ['chef', 'branch'];
    if (status === 'completed') notifyRoles = ['branch', 'admin'];
    if (status === 'in_transit') notifyRoles = ['branch', 'admin'];
    if (status === 'cancelled') notifyRoles = ['branch', 'production', 'admin'];

    if (notifyRoles.length > 0) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch }).select('_id');
      const io = req.app.get('io');
      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'order_status_updated',
          `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
          { orderId: id },
          io
        );
      }
    }

    const io = req.app.get('io');
    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    io.to('production').emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error updating order status at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const confirmDelivery = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch');
    if (!order || order.status !== 'in_transit') {
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    for (const item of order.items) {
      await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        { $inc: { currentStock: item.quantity } },
        { upsert: true }
      );
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({ status: 'delivered', changedBy: req.user.id });
    await order.save();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] }, branchId: order.branch }).select('_id');
    const io = req.app.get('io');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'order_delivered',
        `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${order.branch.name}`,
        { orderId: id },
        io
      );
    }

    io.to(order.branch.toString()).emit('orderStatusUpdated', { orderId: id, status: 'delivered', user: req.user });
    io.to('production').emit('orderStatusUpdated', { orderId: id, status: 'delivered', user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`Error confirming delivery at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const approveReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(id).populate('order');
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    if (status === 'approved') {
      for (const item of returnRequest.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order.branch, product: item.product },
          { $inc: { currentStock: -item.quantity } },
          { upsert: true }
        );
      }
    }

    returnRequest.status = status;
    if (reviewNotes) returnRequest.reviewNotes = reviewNotes.trim();
    await returnRequest.save();

    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order.branch }).select('_id');
    const io = req.app.get('io');
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnRequest.order.orderNumber}`,
        { returnId: id, orderId: returnRequest.order._id },
        io
      );
    }

    io.to(returnRequest.order.branch.toString()).emit('returnStatusUpdated', { returnId: id, status });
    res.status(200).json(returnRequest);
  } catch (err) {
    console.error(`Error approving return at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, confirmDelivery, approveReturn, assignChefs };