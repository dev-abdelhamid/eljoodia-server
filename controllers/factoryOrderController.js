const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const FactoryOrder = require('../models/FactoryOrder');
const Product = require('../models/Product');
const User = require('../models/User');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const ProductionAssignment = require('../models/ProductionAssignment');
const { createNotification } = require('./notificationController');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

exports.createFactoryOrder = async (req, res) => {
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
    if (!items.every(item => isValidObjectId(item.product) && item.quantity > 0 && (!item.assignedTo || isValidObjectId(item.assignedTo)))) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بيانات المنتج أو الكمية أو الشيف غير صالحة' : 'Invalid product, quantity, or chef data' });
    }

    const products = await Product.find({ _id: { $in: items.map(i => i.product) } })
      .populate('department', 'name nameEn')
      .session(session);
    if (products.length !== items.length) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    const chefIds = items.filter(i => i.assignedTo).map(i => i.assignedTo);
    const chefs = chefIds.length > 0 ? await User.find({ _id: { $in: chefIds }, role: 'chef' }).session(session) : [];
    if (chefIds.length > 0 && chefs.length !== chefIds.length) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض الشيفات غير موجودين' : 'Some chefs not found' });
    }

    if (req.user.role === 'chef') {
      const userDept = req.user.department.toString();
      if (!products.every(p => p.department._id.toString() === userDept)) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'يمكنك فقط طلب منتجات قسمك' : 'You can only request products from your department' });
      }
    } else {
      for (const item of items) {
        const product = products.find(p => p._id.toString() === item.product.toString());
        const chef = chefs.find(c => c._id.toString() === item.assignedTo);
        if (chef && chef.department.toString() !== product.department._id.toString()) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: isRtl ? 'الشيف لا ينتمي إلى قسم المنتج' : 'Chef does not belong to product department' });
        }
      }
    }

    const orderItems = items.map(item => {
      const prod = products.find(p => p._id.toString() === item.product.toString());
      let assignedTo;
      let itemStatus = 'pending';
      if (req.user.role !== 'chef' && item.assignedTo) {
        assignedTo = item.assignedTo;
        itemStatus = 'assigned';
      } else if (req.user.role === 'chef') {
        assignedTo = req.user.id;
        itemStatus = 'assigned';
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

    // Create tasks for assigned items
    const tasks = orderItems
      .filter(item => item.assignedTo)
      .map(item => ({
        factoryOrder: order._id,
        product: item.product,
        quantity: item.quantity,
        assignedTo: item.assignedTo,
        status: req.user.role === 'chef' ? 'pending' : 'in_progress',
      }));

    if (tasks.length > 0) {
      await ProductionAssignment.insertMany(tasks, { session });
      for (const task of tasks) {
        const product = products.find(p => p._id.toString() === task.product.toString());
        await createNotification(
          task.assignedTo,
          'factoryTaskAssigned',
          isRtl ? `تم تعيينك لإنتاج ${product.name} في طلب المصنع ${order.orderNumber}` : 
                 `Assigned to produce ${product.nameEn || product.name} for factory order ${order.orderNumber}`,
          {
            factoryOrderId: order._id,
            taskId: task._id,
            chefId: task.assignedTo,
            productId: task.product,
            productName: isRtl ? product.name : product.nameEn || product.name,
            quantity: task.quantity,
            eventId: `${task._id}-factoryTaskAssigned`,
            isRtl,
          },
          req.io,
          false,
          isRtl
        );
      }
    }

    const populatedOrder = await FactoryOrder.findById(order._id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role,
        }),
      })
      .session(session)
      .lean();

    await session.commitTransaction();
    await createNotification(
      req.user.id,
      'factoryOrderCreated',
      isRtl ? `طلب مصنع جديد ${order.orderNumber}` : `New factory order ${order.orderNumber}`,
      {
        factoryOrderId: order._id,
        orderNumber: order.orderNumber,
        eventId: `${order._id}-factoryOrderCreated`,
        isRtl,
      },
      req.io,
      true,
      isRtl
    );

    res.status(201).json({ success: true, data: populatedOrder, message: isRtl ? 'تم إنشاء الطلب بنجاح' : 'Order created successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

exports.getFactoryOrders = async (req, res) => {
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
    if (department && isValidObjectId(department)) query['items.department'] = department;
    if (req.user.role === 'production' && req.user.department) {
      query['items.department'] = req.user.department._id;
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
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role,
        }),
      })
      .sort({ [sortBy || 'createdAt']: sortOrder === 'desc' ? -1 : 1 })
      .lean();

    res.status(200).json({ success: true, data: orders, message: isRtl ? 'تم جلب الطلبات بنجاح' : 'Orders fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory orders:`, err.message);
    res.status(500).json({ success: false, data: [], message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

exports.getFactoryOrderById = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
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
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role,
        }),
      })
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'chef' && !order.items.some(item => item.assignedTo && item.assignedTo._id.toString() === req.user.id.toString())) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح للوصول إلى هذا الطلب' : 'Not authorized to access this order' });
    }

    res.status(200).json({ success: true, data: order, message: isRtl ? 'تم جلب الطلب بنجاح' : 'Order fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

exports.approveFactoryOrder = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    if (!['admin', 'production'].includes(req.user.role)) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بالموافقة' : 'Not authorized to approve' });
    }

    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'requested') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة الطلب' : 'Order is not in requested status' });
    }

    order.status = 'approved';
    order.statusHistory.push({ status: 'approved', changedBy: req.user.id });
    await order.save({ session });

    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role,
        }),
      })
      .session(session)
      .lean();

    await session.commitTransaction();
    await createNotification(
      order.createdBy,
      'orderApproved',
      isRtl ? `تم اعتماد طلب المصنع ${order.orderNumber}` : `Factory order ${order.orderNumber} approved`,
      { orderId: order._id, eventId: `${order._id}-orderApproved`, isRtl },
      req.io,
      true,
      isRtl
    );

    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم الموافقة على الطلب' : 'Order approved successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

exports.assignFactoryChefs = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id } = req.params;
    const { items } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    if (!['admin', 'production'].includes(req.user.role)) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بتعيين الشيفات' : 'Not authorized to assign chefs' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'قائمة العناصر غير صالحة' : 'Invalid items list' });
    }

    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'approved') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب لم يتم الموافقة عليه' : 'Order not approved' });
    }

    const chefIds = items.map(i => i.assignedTo).filter(id => id);
    if (chefIds.length > 0 && !chefIds.every(id => isValidObjectId(id))) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات الشيفات غير صالحة' : 'Invalid chef IDs' });
    }

    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).session(session);
    const products = await Product.find({ _id: { $in: order.items.map(i => i.product) } }).session(session);

    for (const item of items) {
      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'العنصر غير موجود' : 'Item not found' });
      }
      const product = products.find(p => p._id.toString() === orderItem.product.toString());
      const chef = chefs.find(c => c._id.toString() === item.assignedTo);
      if (chef && product && chef.department.toString() !== product.department.toString()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'الشيف لا ينتمي إلى قسم المنتج' : 'Chef does not belong to product department' });
      }
      orderItem.assignedTo = item.assignedTo || undefined;
      orderItem.status = item.assignedTo ? 'assigned' : 'pending';
    }

    order.status = order.items.every(i => i.status === 'assigned') ? 'in_production' : 'approved';
    await order.save({ session });

    const tasks = items
      .filter(item => item.assignedTo)
      .map(item => ({
        factoryOrder: order._id,
        product: order.items.find(i => i._id.toString() === item.itemId).product,
        quantity: order.items.find(i => i._id.toString() === item.itemId).quantity,
        assignedTo: item.assignedTo,
        status: 'in_progress',
      }));

    await ProductionAssignment.insertMany(tasks, { session });

    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role,
        }),
      })
      .session(session)
      .lean();

    for (const task of tasks) {
      const product = products.find(p => p._id.toString() === task.product.toString());
      await createNotification(
        task.assignedTo,
        'factoryTaskAssigned',
        isRtl ? `تم تعيينك لإنتاج ${product.name} في طلب المصنع ${order.orderNumber}` : 
               `Assigned to produce ${product.nameEn || product.name} for factory order ${order.orderNumber}`,
        {
          factoryOrderId: order._id,
          taskId: task._id,
          chefId: task.assignedTo,
          productId: task.product,
          productName: isRtl ? product.name : product.nameEn || product.name,
          quantity: task.quantity,
          eventId: `${task._id}-factoryTaskAssigned`,
          isRtl,
        },
        req.io,
        false,
        isRtl
      );
    }

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

exports.updateItemStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id: orderId, itemId } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو العنصر غير صالح' : 'Invalid order or item ID' });
    }

    if (!['pending', 'assigned', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة العنصر غير صالحة' : 'Invalid item status' });
    }

    const order = await FactoryOrder.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    const item = order.items.find(i => i._id.toString() === itemId);
    if (!item) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'العنصر غير موجود' : 'Item not found' });
    }

    if (req.user.role === 'chef' && (!item.assignedTo || item.assignedTo.toString() !== req.user.id.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بتحديث هذا العنصر' : 'Not authorized to update this item' });
    }

    item.status = status;
    await ProductionAssignment.updateOne(
      { factoryOrder: orderId, product: item.product, assignedTo: item.assignedTo },
      { status: status === 'completed' ? 'completed' : 'in_progress' },
      { session }
    );

    order.status = order.items.every(i => i.status === 'completed') ? 'completed' : order.status;
    order.statusHistory.push({ status: order.status, changedBy: req.user.id });
    await order.save({ session });

    const populatedOrder = await FactoryOrder.findById(orderId)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role,
        }),
      })
      .session(session)
      .lean();

    if (status === 'completed') {
      const product = await Product.findById(item.product).session(session);
      await createNotification(
        req.user.id,
        'factoryTaskCompleted',
        isRtl ? `تم إكمال مهمة (${product.name}) في طلب المصنع ${order.orderNumber}` : 
               `Task (${product.nameEn || product.name}) completed for factory order ${order.orderNumber}`,
        {
          factoryOrderId: order._id,
          taskId: item._id,
          chefId: req.user.id,
          productId: item.product,
          productName: isRtl ? product.name : product.nameEn || product.name,
          eventId: `${item._id}-factoryTaskCompleted`,
          isRtl,
        },
        req.io,
        false,
        isRtl
      );

      if (order.status === 'completed') {
        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        for (const user of [...adminUsers, ...productionUsers]) {
          await createNotification(
            user._id,
            'factoryOrderCompleted',
            isRtl ? `تم اكتمال طلب المصنع ${order.orderNumber} بالكامل` : `Factory order ${order.orderNumber} fully completed`,
            {
              factoryOrderId: order._id,
              eventId: `${order._id}-factoryOrderCompleted`,
              isRtl,
            },
            req.io,
            true,
            isRtl
          );
        }
      }
    }

    await session.commitTransaction();
    req.io?.emit('itemStatusUpdated', { orderId, itemId, status });

    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تحديث حالة العنصر' : 'Item status updated successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating item status:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

exports.confirmFactoryProduction = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    if (!['admin', 'production'].includes(req.user.role)) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بتأكيد الإنتاج' : 'Not authorized to confirm production' });
    }

    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب لم يتم إكماله' : 'Order not completed' });
    }

    if (order.inventoryProcessed) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب تم معالجته بالفعل' : 'Order already processed' });
    }

    for (const item of order.items) {
      const inventory = await FactoryInventory.findOne({ product: item.product }).session(session);
      if (inventory) {
        inventory.quantity += item.quantity;
        await inventory.save({ session });
      } else {
        const newInventory = new FactoryInventory({
          product: item.product,
          quantity: item.quantity,
          department: item.department,
        });
        await newInventory.save({ session });
      }

      const history = new FactoryInventoryHistory({
        product: item.product,
        quantity: item.quantity,
        action: 'stocked',
        order: order._id,
        performedBy: req.user.id,
      });
      await history.save({ session });
    }

    order.inventoryProcessed = true;
    order.status = 'stocked';
    order.statusHistory.push({ status: 'stocked', changedBy: req.user.id });
    await order.save({ session });

    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role,
        }),
      })
      .session(session)
      .lean();

    await session.commitTransaction();
    req.io?.emit('orderStatusUpdated', { orderId: id, status: 'stocked' });

    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تأكيد الإنتاج' : 'Production confirmed successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming factory production:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

exports.getAvailableProducts = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    let query = { isActive: true };
    if (req.user.role === 'chef' && req.user.department) {
      query.department = req.user.department;
    }

    const products = await Product.find(query)
      .select('name nameEn code department unit unitEn')
      .populate({
        path: 'department',
        select: 'name nameEn',
        transform: (doc) => ({
          _id: doc._id,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
        }),
      })
      .lean();

    const transformedProducts = products.map(p => ({
      ...p,
      displayName: translateField(p, 'name', lang),
      displayUnit: translateField(p, 'unit', lang),
    }));

    res.status(200).json({ success: true, data: transformedProducts, message: isRtl ? 'تم جلب المنتجات المتاحة بنجاح' : 'Available products fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching available products:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};