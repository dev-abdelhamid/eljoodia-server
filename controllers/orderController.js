const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: ['in_transit', 'delivered'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
};

const createOrder = async (req, res) => {
  try {
    const { orderNumber, items, status, notes, priority, branchId } = req.body;
    const io = req.app.get('io');
    let branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || item.quantity < 1 || !item.price || item.price < 0) {
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة: معرف المنتج، الكمية، أو السعر غير صالح' });
      }
    }

    const newOrder = new Order({
      orderNumber,
      branch,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        status: 'pending',
      })),
      status: status || 'pending',
      notes: notes?.trim(),
      priority: priority || 'medium',
      createdBy: req.user.id,
      totalAmount: items.reduce((sum, item) => sum + item.quantity * item.price, 0),
    });

    await newOrder.save();
    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .lean();

    io.to(`branch-${branch}`).emit('orderCreated', populatedOrder);
    res.status(201).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في إنشاء الطلب:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(orders);
  } catch (err) {
    console.error('خطأ في جلب الطلبات:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { status, notes } = req.body;
    const { id } = req.params;
    const io = req.app.get('io');

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

    io.to(`branch-${order.branch}`).emit('orderStatusUpdated', { orderId: id, status, user: req.user });
    if (status === 'completed') {
      io.to(`branch-${order.branch}`).emit('taskCompleted', { orderId: id, orderNumber: order.orderNumber });
    }
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في تحديث حالة الطلب:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const confirmDelivery = async (req, res) => {
  try {
    const { id } = req.params;
    const io = req.app.get('io');

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

    io.to(`branch-${order.branch}`).emit('orderStatusUpdated', { orderId: id, status: 'delivered', user: req.user });
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في تأكيد التسليم:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const approveReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;
    const io = req.app.get('io');

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

    io.to(`branch-${returnRequest.order.branch}`).emit('returnStatusUpdated', { returnId: id, status, returnNote: reviewNotes });
    res.status(200).json(returnRequest);
  } catch (err) {
    console.error('خطأ في الموافقة على الإرجاع:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const assignChefs = async (req, res) => {
  try {
    const { items } = req.body;
    const { id: orderId } = req.params;
    const io = req.app.get('io');

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

    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        return res.status(400).json({ success: false, message: 'معرفات غير صالحة' });
      }

      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في الطلب` });
      }

      const chef = await User.findById(item.assignedTo).populate('department');
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo });
      const product = await Product.findById(orderItem.product).populate('department');

      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department._id.toString() !== product.department._id.toString()) {
        return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع القسم' });
      }

      order.items = order.items.map(i =>
        i._id.toString() === item.itemId ? { ...i, assignedTo: item.assignedTo, status: 'assigned' } : i
      );

      const assignment = await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId: item.itemId },
        { chef: chefProfile._id, product: orderItem.product, quantity: orderItem.quantity, status: 'pending' },
        { upsert: true, new: true }
      );

      const populatedAssignment = await ProductionAssignment.findById(assignment._id)
        .populate('order', 'orderNumber')
        .populate('product', 'name')
        .populate('chef', 'user')
        .lean();

      io.to(`chef-${chefProfile._id}`).emit('taskAssigned', populatedAssignment);
    }

    order.status = order.items.every(i => i.status === 'assigned') ? 'in_production' : order.status;
    await order.save();

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .lean();

    io.to(`branch-${order.branch}`).emit('orderUpdated', populatedOrder);
    io.to('production').emit('orderUpdated', populatedOrder);
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error('خطأ في تعيين الشيفات:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, confirmDelivery, approveReturn, assignChefs };