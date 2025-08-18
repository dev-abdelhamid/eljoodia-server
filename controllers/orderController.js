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
    in_production: ['cancelled', 'completed'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
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
      if (!isValidObjectId(item.product)) {
        throw new Error(`معرف المنتج غير صالح: ${item.product}`);
      }
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
        status: 'pending',
      })),
      status: status || 'pending',
      notes: notes?.trim(),
      priority: priority || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
    });

    await newOrder.save();

    const io = req.app.get('io');
    await syncOrderTasks(newOrder._id, io);

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
    };
    io.to(branch.toString()).emit('orderCreated', orderData);
    io.to('production').emit('orderCreated', orderData);
    io.to('admin').emit('orderCreated', orderData);

    res.status(201).json(populatedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating order:`, err);
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
      .populate('branch')
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين الشيفات' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const io = req.app.get('io');
    console.log('Assigning chefs after approval'); // log إضافي
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        return res.status(400).json({ success: false, message: 'معرفات غير صالحة' });
      }

      const orderItem = order.items.find((i) => i._id.toString() === item.itemId);
      if (!orderItem) {
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في الطلب` });
      }

      const chef = await User.findById(item.assignedTo).populate('department').lean();
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo }).lean();
      const product = orderItem.product;

      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department?._id.toString() !== product.department?._id.toString()) {
        return res.status(400).json({ success: false, message: `الشيف ${chef?.name || item.assignedTo} غير صالح أو غير متطابق مع القسم` });
      }

      const updatedOrder = await Order.findById(orderId);
      const targetItem = updatedOrder.items.id(item.itemId);
      if (!targetItem) {
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في الطلب` });
      }

      targetItem.assignedTo = item.assignedTo;
      targetItem.status = 'assigned';
      targetItem.department = product.department;

      const assignment = await ProductionAssignment.findOneAndUpdate(
        { order: orderId, itemId: item.itemId },
        { chef: chefProfile._id, product: product._id, quantity: orderItem.quantity, status: 'pending', itemId: item.itemId },
        { upsert: true, new: true }
      );

      await createNotification(
        item.assignedTo,
        'task_assigned',
        `تم تعيينك لإنتاج ${product.name} في الطلب ${order.orderNumber}`,
        { taskId: assignment._id, orderId, orderNumber: order.orderNumber, branchId: order.branch?._id },
        io
      );
      io.to(`chef-${item.assignedTo}`).emit('taskAssigned', {
        _id: assignment._id,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: product._id, name: product.name },
        chef: { _id: item.assignedTo, username: chef.name || 'Unknown' },
        quantity: orderItem.quantity,
        itemId: item.itemId,
        status: 'pending',
        branchId: order.branch?._id,
        branchName: order.branch?.name || 'Unknown',
      });
      await updatedOrder.save();
    }

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .lean();

    const orderData = {
      ...populatedOrder,
      branchId: order.branch?._id,
      branchName: order.branch?.name || 'Unknown',
    };
    io.to(order.branch?._id.toString()).emit('orderUpdated', orderData);
    io.to('production').emit('orderUpdated', orderData);
    io.to('admin').emit('orderUpdated', orderData);
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
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

    orders.forEach((order) => {
      order.items.forEach((item) => {
        item.isCompleted = item.status === 'completed';
      });
    });

    res.status(200).json(orders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, err);
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
    if (status === 'in_transit') notifyRoles = ['branch', 'admin'];
    if (status === 'cancelled') notifyRoles = ['branch', 'production', 'admin'];

    const io = req.app.get('io');
    if (notifyRoles.length > 0) {
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
    };
    io.to(order.branch.toString()).emit('orderStatusUpdated', orderData);
    io.to('production').emit('orderStatusUpdated', orderData);
    io.to('admin').emit('orderStatusUpdated', orderData);

    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error updating order status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const confirmDelivery = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('items.product').populate('branch').lean();
    if (!order || order.status !== 'in_transit') {
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const updatedOrder = await Order.findById(id);
    for (const item of updatedOrder.items) {
      await Inventory.findOneAndUpdate(
        { branch: updatedOrder.branch, product: item.product },
        { $inc: { currentStock: item.quantity } },
        { upsert: true }
      );
    }

    updatedOrder.status = 'delivered';
    updatedOrder.deliveredAt = new Date();
    updatedOrder.statusHistory.push({ status: 'delivered', changedBy: req.user.id });
    await updatedOrder.save();

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
    };
    io.to(order.branch?._id.toString()).emit('orderStatusUpdated', orderData);
    io.to('production').emit('orderStatusUpdated', orderData);
    io.to('admin').emit('orderStatusUpdated', orderData);
    res.status(200).json(populatedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err);
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

    const returnRequest = await Return.findById(id).populate('order').lean();
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    const updatedReturn = await Return.findById(id);
    if (status === 'approved') {
      for (const item of updatedReturn.items) {
        const inventory = await Inventory.findOne({ branch: returnRequest.order?.branch, product: item.product });
        if (!inventory || inventory.currentStock < item.quantity) {
          return res.status(400).json({ success: false, message: `المخزون غير كافٍ للمنتج ${item.product.name || item.product}` });
        }
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: item.product },
          { $inc: { currentStock: -item.quantity } },
          { upsert: true }
        );
      }
    }

    updatedReturn.status = status;
    if (reviewNotes) updatedReturn.reviewNotes = reviewNotes.trim();
    await updatedReturn.save();

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

    io.to(returnRequest.order?.branch.toString()).emit('returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
    });
    io.to('admin').emit('returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnRequest.order?.branch,
    });
    res.status(200).json(updatedReturn);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error approving return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, confirmDelivery, approveReturn, assignChefs };