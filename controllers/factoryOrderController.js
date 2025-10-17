const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const FactoryOrder = require('../models/FactoryOrder');
const Product = require('../models/Product');
const User = require('../models/User');

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

    const products = await Product.find({ _id: { $in: items.map(i => i.product) } }).session(session);
    if (products.length !== items.length) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    const order = new FactoryOrder({
      orderNumber,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        status: 'pending',
      })),
      status: 'pending',
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

const getFactoryOrders = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }

    const { status, priority, department, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (department && isValidObjectId(department)) query['items.product.department'] = department;
    if (req.user.role === 'production' && req.user.department) {
      query['items.product.department'] = req.user.department._id;
    }

    const orders = await FactoryOrder.find(query)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
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
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
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
      const chef = await User.findById(item.assignedTo).session(session);
      if (!chef) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الشيف غير موجود' : 'Chef not found' });
      }
      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
    }

    order.status = order.items.every(i => i.status === 'assigned') ? 'in_production' : order.status;
    if (notes) order.notes = notes;
    order.updatedBy = req.user.id;
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

    order.inventoryProcessed = true;
    order.updatedBy = req.user.id;
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
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تأكيد الإنتاج بنجاح' : 'Production confirmed successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming production:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createFactoryOrder,
  getFactoryOrders,
  getFactoryOrderById,
  assignFactoryChefs,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
};