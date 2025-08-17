const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const ProductionAssignment = require('../models/ProductionAssignment');
const Return = require('../models/Return');
const Notification = require('../models/Notification');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validTransitions = {
  pending: ['approved', 'cancelled'],
  approved: ['in_production', 'cancelled'],
  in_production: ['completed', 'cancelled'],
  completed: ['in_transit'],
  in_transit: ['delivered'],
  delivered: [],
  cancelled: [],
};

const validateStatusTransition = (currentStatus, newStatus) => {
  return validTransitions[currentStatus]?.includes(newStatus) || false;
};

const createNotification = async (to, type, message, data, io) => {
  try {
    const notification = new Notification({
      user: to,
      type,
      message,
      data,
      read: false,
      createdAt: new Date(),
    });
    await notification.save();
    io.to(`user-${to}`).emit('newNotification', {
      _id: notification._id,
      user: to,
      type,
      message,
      data,
      read: false,
      createdAt: notification.createdAt,
    });
    console.log(`Notification sent to user-${to} at ${new Date().toISOString()}:`, { type, message });
    return notification;
  } catch (err) {
    console.error(`Error creating notification for user-${to} at ${new Date().toISOString()}:`, err);
    throw err;
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { orderNumber, items, status = 'pending', notes, priority = 'medium', branchId } = req.body;
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {
      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });
    }
    if (!orderNumber || !items?.length) {
      return res.status(400).json({ success: false, message: 'رقم الطلب ومصفوفة العناصر مطلوبة' });
    }
    if (!['low', 'medium', 'high', 'urgent'].includes(priority)) {
      return res.status(400).json({ success: false, message: 'الأولوية غير صالحة' });
    }
    if (!validTransitions['pending'].includes(status)) {
      return res.status(400).json({ success: false, message: `حالة الطلب ${status} غير صالحة عند الإنشاء` });
    }

    const mergedItems = items.reduce((acc, item) => {
      if (!isValidObjectId(item.product) || !item.quantity || item.quantity <= 0 || !item.price || item.price < 0) {
        throw new Error(`بيانات العنصر غير صالحة: ${JSON.stringify(item)}`);
      }
      const existing = acc.find((i) => i.product.toString() === item.product.toString());
      if (existing) existing.quantity += item.quantity;
      else acc.push({ product: item.product, quantity: item.quantity, price: item.price });
      return acc;
    }, []);

    const products = await Product.find({ _id: { $in: mergedItems.map((i) => i.product) } })
      .select('name price department')
      .populate('department', 'name code')
      .session(session);
    if (products.length !== mergedItems.length) {
      throw new Error('بعض المنتجات غير موجودة');
    }

    const newOrder = new Order({
      orderNumber,
      branch,
      items: mergedItems.map((item) => {
        const product = products.find((p) => p._id.toString() === item.product.toString());
        return {
          product: item.product,
          quantity: item.quantity,
          price: item.price,
          department: product.department,
          status: 'pending',
        };
      }),
      status,
      notes: notes?.trim(),
      priority,
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      statusHistory: [{ status, changedBy: req.user.id, changedAt: new Date() }],
    });

    await newOrder.save({ session });

    const io = req.app.get('io');
    const assignments = [];
    for (const item of newOrder.items) {
      const product = products.find((p) => p._id.toString() === item.product.toString());
      const chef = await mongoose.model('Chef').findOne({ department: product.department }).session(session);
      if (chef) {
        const assignment = new ProductionAssignment({
          order: newOrder._id,
          product: item.product,
          chef: chef._id,
          quantity: item.quantity,
          itemId: item._id,
          status: 'pending',
        });
        assignments.push(assignment);
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
          status: 'pending',
        });
      }
    }
    await ProductionAssignment.insertMany(assignments, { session });
    await newOrder.save({ session });

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
    const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: branch })
      .select('_id')
      .session(session);
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

    await session.commitTransaction();
    res.status(201).json({ success: true, data: populatedOrder });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error creating order at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
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
        select: 'name price department',
        populate: { path: 'department', select: 'name code isActive' },
      })
      .populate('branch')
      .session(session);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }
    if (!['approved', 'in_production'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون في حالة الموافقة أو الإنتاج' });
    }

    const io = req.app.get('io');
    const assignments = [];
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error(`معرفات غير صالحة: itemId=${item.itemId}, assignedTo=${item.assignedTo}`);
      }

      const orderItem = order.items.id(item.itemId);
      if (!orderItem) {
        throw new Error(`العنصر ${item.itemId} غير موجود في الطلب`);
      }

      const chef = await User.findById(item.assignedTo).populate('department').session(session);
      const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo }).session(session);
      const product = orderItem.product;

      if (!chef || chef.role !== 'chef' || !chefProfile || chef.department?._id.toString() !== product.department._id.toString()) {
        throw new Error(`الشيف ${chef?.name || item.assignedTo} غير صالح أو غير متطابق مع القسم`);
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';

      const assignment = {
        order: orderId,
        product: product._id,
        chef: chefProfile._id,
        quantity: orderItem.quantity,
        itemId: item.itemId,
        status: 'pending',
      };
      assignments.push(assignment);

      await createNotification(
        item.assignedTo,
        'task_assigned',
        `تم تعيينك لإنتاج ${product.name} في الطلب ${order.orderNumber}`,
        { taskId: assignment.itemId, orderId },
        io
      );
      io.to(`chef-${item.assignedTo}`).emit('taskAssigned', {
        _id: assignment.itemId,
        order: { _id: orderId, orderNumber: order.orderNumber },
        product: { _id: product._id, name: product.name },
        chef: { _id: item.assignedTo, username: chef.name },
        quantity: orderItem.quantity,
        itemId: item.itemId,
        status: 'pending',
      });
    }

    await ProductionAssignment.deleteMany({ order: orderId, itemId: { $in: items.map((i) => i.itemId) } }, { session });
    await ProductionAssignment.insertMany(assignments, { session });

    if (order.items.every((item) => item.status === 'assigned' || item.status === 'in_progress' || item.status === 'completed')) {
      order.status = 'in_production';
      order.statusHistory.push({ status: 'in_production', changedBy: req.user.id, changedAt: new Date() });
    }
    await order.save({ session });

    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .lean();

    io.to(order.branch.toString()).emit('orderUpdated', populatedOrder);
    io.to('production').emit('orderUpdated', populatedOrder);

    await session.commitTransaction();
    res.status(200).json({ success: true, data: populatedOrder });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error assigning chefs at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, branch, page = 1, limit = 10, department } = req.query;
    const query = {};

    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;
    if (req.user.role === 'production' && req.user.department) {
      query['items.department'] = req.user.department._id;
    }
    if (department && isValidObjectId(department)) {
      query['items.department'] = department;
    }

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
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Order.countDocuments(query);
    res.status(200).json({
      success: true,
      data: orders.map((order) => ({
        ...order,
        items: order.items.map((item) => ({
          ...item,
          isCompleted: item.status === 'completed',
        })),
      })),
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error(`Error fetching orders at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { status, notes } = req.body;
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).populate('branch').session(session);
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (req.user.role === 'branch' && order.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
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
    await order.save({ session });

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

    const notifyRoles = {
      approved: ['production'],
      in_production: ['chef', 'branch'],
      completed: ['branch', 'admin'],
      in_transit: ['branch', 'admin'],
      cancelled: ['branch', 'production', 'admin'],
    }[status] || [];

    if (notifyRoles.length > 0) {
      const usersToNotify = await User.find({ role: { $in: notifyRoles }, branchId: order.branch })
        .select('_id')
        .session(session);
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
    io.to(order.branch.toString()).emit('orderStatusUpdated', {
      orderId: id,
      status,
      statusHistory: populatedOrder.statusHistory,
    });
    io.to('production').emit('orderStatusUpdated', {
      orderId: id,
      status,
      statusHistory: populatedOrder.statusHistory,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, data: populatedOrder });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error updating order status at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id)
      .populate('items.product')
      .populate('branch')
      .session(session);
    if (!order || order.status !== 'in_transit') {
      return res.status(400).json({ success: false, message: 'الطلب يجب أن يكون قيد التوصيل' });
    }

    if (req.user.role === 'branch' && order.branch._id.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const inventoryUpdates = order.items.map((item) => ({
      updateOne: {
        filter: { branch: order.branch, product: item.product },
        update: { $inc: { currentStock: item.quantity } },
        upsert: true,
      },
    }));
    await Inventory.bulkWrite(inventoryUpdates, { session });

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({ status: 'delivered', changedBy: req.user.id, changedAt: new Date() });
    await order.save({ session });

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

    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] }, branchId: order.branch })
      .select('_id')
      .session(session);
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

    io.to(order.branch.toString()).emit('orderStatusUpdated', {
      orderId: id,
      status: 'delivered',
      statusHistory: populatedOrder.statusHistory,
    });
    io.to('production').emit('orderStatusUpdated', {
      orderId: id,
      status: 'delivered',
      statusHistory: populatedOrder.statusHistory,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, data: populatedOrder });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error confirming delivery at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    const returnRequest = await Return.findById(id).populate('order').session(session);
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (req.user.role === 'branch' && returnRequest.order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (status === 'approved') {
      const inventoryUpdates = returnRequest.items.map((item) => ({
        updateOne: {
          filter: { branch: returnRequest.order.branch, product: item.product },
          update: { $inc: { currentStock: -item.quantity } },
          upsert: true,
        },
      }));
      await Inventory.bulkWrite(inventoryUpdates, { session });

      returnRequest.status = 'processed';
    } else {
      returnRequest.status = status;
    }
    if (reviewNotes) returnRequest.reviewNotes = reviewNotes.trim();
    returnRequest.updatedAt = new Date();
    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(id)
      .populate({
        path: 'order',
        select: 'orderNumber branch',
        populate: { path: 'branch', select: 'name' },
      })
      .populate('items.product', 'name')
      .lean();

    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnRequest.order.branch })
      .select('_id')
      .session(session);
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

    io.to(returnRequest.order.branch.toString()).emit('returnStatusUpdated', {
      orderId: returnRequest.order._id,
      returnId: id,
      status: returnRequest.status,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, data: populatedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error(`Error approving return at ${new Date().toISOString()}:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createOrder, getOrders, updateOrderStatus, confirmDelivery, approveReturn, assignChefs };