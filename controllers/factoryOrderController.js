const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const FactoryOrder = require('../models/FactoryOrder');
const Product = require('../models/Product');
const User = require('../models/User');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const isValidObjectId = (id) => mongoose.isValidObjectId(id);
const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};
const createFactoryOrder = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { orderNumber, items, notes, priority } = req.body;
    if (!items.every(item => isValidObjectId(item.product) && item.quantity > 0)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بيانات المنتج أو الكمية غير صالحة' : 'Invalid product or quantity data' });
    }
    const products = await Product.find({ _id: { $in: items.map(i => i.product) } }).populate('department', 'chef').session(session);
    if (products.length !== items.length) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }
    if (req.user.role === 'chef') {
      const userDept = req.user.department.toString();
      if (!products.every(p => p.department._id.toString() === userDept)) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'يمكنك فقط طلب منتجات قسمك' : 'You can only request products from your department' });
      }
    }
    const orderItems = items.map(item => {
      const prod = products.find(p => p._id.toString() === item.product.toString());
      let assignedTo;
      let itemStatus = 'pending';
      if (req.user.role !== 'chef') {
        assignedTo = prod.department?.chef;
        itemStatus = assignedTo ? 'assigned' : 'pending';
      }
      return {
        product: item.product,
        quantity: item.quantity,
        status: itemStatus,
        assignedTo: assignedTo || undefined,
        department: prod.department._id,
      };
    });
    const allAssigned = orderItems.every(i => i.status === 'assigned');
    const order = new FactoryOrder({
      orderNumber,
      items: orderItems,
      status: req.user.role === 'chef' ? 'requested' : allAssigned ? 'in_production' : 'approved',
      notes: notes || '',
      priority: priority || 'medium',
      createdBy: req.user.id,
    });
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(order._id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('newFactoryOrder', populatedOrder);
    res.status(201).json({ success: true, data: populatedOrder, message: isRtl ? 'تم إنشاء الطلب بنجاح' : 'Order created successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};
const approveFactoryOrder = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'requested') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن الموافقة على هذا الطلب' : 'Cannot approve this order' });
    }
    order.status = 'approved';
    order.approvedBy = req.user.id;
    order.approvedAt = new Date();
    order.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      changedAt: new Date(),
    });
    const creator = await User.findById(order.createdBy).select('role department').session(session);
    if (creator.role === 'chef') {
      order.items.forEach(item => {
        item.assignedTo = creator._id;
        item.department = creator.department;
        item.status = 'assigned';
      });
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('orderStatusUpdated', { orderId: id, status: order.status });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم الموافقة على الطلب بنجاح' : 'Order approved successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};
const getFactoryOrders = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { status, priority, department, sortBy, sortOrder } = req.query;
    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (department && isValidObjectId(department)) query['items.product.department'] = department;
    if (req.user.role === 'production' && req.user.department) {
      query['items.product.department'] = req.user.department._id;
    }
    if (req.user.role === 'chef') {
      query['items.assignedTo'] = req.user.id;
    }
    const orders = await FactoryOrder.find(query)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .sort({ [sortBy || 'createdAt']: sortOrder === 'desc' ? -1 : 1 })
      .lean();
    res.status(200).json({ success: true, data: orders, message: isRtl ? 'تم جلب الطلبات بنجاح' : 'Orders fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory orders:`, err.message);
    res.status(500).json({ success: false, data: [], message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};
const getFactoryOrderById = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    res.status(200).json({ success: true, data: order, message: isRtl ? 'تم جلب الطلب بنجاح' : 'Order fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory order:`, err.message);
    res.status(500).json({ success: false, data: null, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};
const assignFactoryChefs = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { id } = req.params;
    const { items, notes } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'approved') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "تم الموافقة"' : 'Order must be in approved status' });
    }
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.assignedTo)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف العنصر أو الشيف غير صالح' : 'Invalid item or chef ID' });
      }
      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'العنصر غير موجود في الطلب' : 'Item not found in order' });
      }
      const chef = await User.findById(item.assignedTo).select('role department').session(session);
      if (!chef || chef.role !== 'chef') {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الشيف غير موجود' : 'Chef not found' });
      }
      const prod = await Product.findById(orderItem.product).select('department').session(session);
      if (chef.department.toString() !== prod.department.toString()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'الشيف غير تابع لقسم المنتج' : 'Chef does not belong to the product department' });
      }
      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
    }
    order.status = order.items.every(i => i.status === 'assigned') ? 'in_production' : order.status;
    if (notes) order.notes = notes;
    order.updatedBy = req.user.id;
    order.statusHistory.push({
      status: order.status,
      changedBy: req.user.id,
      changedAt: new Date(),
    });
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('taskAssigned', { orderId: id, items: populatedOrder.items });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تعيين الشيفات بنجاح' : 'Chefs assigned successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};
const updateItemStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { id, itemId } = req.params;
    const { status } = req.body;
    if (!isValidObjectId(id) || !isValidObjectId(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو العنصر غير صالح' : 'Invalid order or item ID' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    const item = order.items.find(i => i._id.toString() === itemId);
    if (!item) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'العنصر غير موجود' : 'Item not found' });
    }
    if (req.user.role === 'chef' && item.assignedTo.toString() !== req.user.id) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح لك بتحديث هذا العنصر' : 'Not authorized to update this item' });
    }
    const validItemTransitions = {
      pending: ['assigned'],
      assigned: ['in_progress'],
      in_progress: ['completed'],
      completed: [],
    };
    if (!validItemTransitions[item.status].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'انتقال حالة العنصر غير صالح' : 'Invalid item status transition' });
    }
    item.status = status;
    if (status === 'in_progress' && !item.startedAt) item.startedAt = new Date();
    if (status === 'completed' && !item.completedAt) item.completedAt = new Date();
    if (order.items.every(i => i.status === 'completed') && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('itemStatusUpdated', { orderId: id, itemId, status });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تحديث حالة العنصر بنجاح' : 'Item status updated successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating item status:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};
const updateFactoryOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { id } = req.params;
    const { status } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    const validTransitions = {
      requested: ['approved', 'cancelled'],
      pending: ['approved', 'cancelled'],
      approved: ['in_production', 'cancelled'],
      in_production: ['completed', 'cancelled'],
      completed: [],
      cancelled: [],
    };
    if (!validTransitions[order.status].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'انتقال الحالة غير صالح' : 'Invalid status transition' });
    }
    order.status = status;
    order.updatedBy = req.user.id;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
    });
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('orderStatusUpdated', { orderId: id, status });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تحديث حالة الطلب بنجاح' : 'Order status updated successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};
const confirmFactoryProduction = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "مكتمل"' : 'Order must be in completed status' });
    }
    if (order.inventoryProcessed) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'تم معالجة المخزون بالفعل' : 'Inventory already processed' });
    }
    const bulkData = {
      userId: req.user.id,
      orderId: order._id,
      items: order.items.map(item => ({
        productId: item.product,
        currentStock: item.quantity,
      })),
    };
    const inventoryResponse = await FactoryInventory.bulkCreateFactory({ body: bulkData }, req, res); // Call bulk create
    order.inventoryProcessed = true;
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('factoryOrderCompleted', { factoryOrderId: id, orderNumber: order.orderNumber });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تأكيد الإنتاج بنجاح' : 'Production confirmed successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming production:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};
const getAvailableProducts = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    let query = { isActive: true };
    if (req.user.role === 'chef') {
      query.department = req.user.department;
    }
    const products = await Product.find(query)
      .select('name nameEn code department unit unitEn')
      .populate('department', 'name nameEn')
      .lean();
    res.status(200).json({ success: true, data: products, message: isRtl ? 'تم جلب المنتجات المتاحة بنجاح' : 'Available products fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching available products:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};
module.exports = {
  createFactoryOrder,
  approveFactoryOrder,
  getFactoryOrders,
  getFactoryOrderById,
  assignFactoryChefs,
  updateItemStatus,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
  getAvailableProducts
};