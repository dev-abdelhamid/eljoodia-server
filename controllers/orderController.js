const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');
const { createReturn, approveReturn } = require('./returnController');
const { assignChefs, approveOrder, startTransit, confirmDelivery, updateOrderStatus, confirmOrderReceipt } = require('./statusController');

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

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, status = 'pending', notes, notesEn, priority = 'medium', branchId, requestedDeliveryDate } = req.body;

    // التحقق من صحة البيانات
    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;
    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'معرف الفرع مطلوب ويجب أن يكون صالحًا' : 'Branch ID is required and must be valid' 
      });
    }

    if (!orderNumber || typeof orderNumber !== 'string' || !items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing or invalid orderNumber or items:`, { orderNumber, items, userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'رقم الطلب ومصفوفة العناصر مطلوبة ويجب أن تكون صالحة' : 'Order number and items array are required and must be valid' 
      });
    }

    // التحقق من صحة العناصر
    for (const item of items) {
      if (!isValidObjectId(item.product) || !Number.isInteger(item.quantity) || item.quantity < 1 || typeof item.price !== 'number' || item.price < 0) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid item data:`, { item, userId: req.user.id });
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? 'بيانات العنصر غير صالحة (معرف المنتج، الكمية، أو السعر)' : 'Invalid item data (product ID, quantity, or price)' 
        });
      }
    }

    // دمج العناصر المتكررة بناءً على معرف المنتج
    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        acc.push({
          product: item.product,
          quantity: item.quantity,
          price: item.price,
          status: 'pending',
          startedAt: null,
          completedAt: null,
        });
      }
      return acc;
    }, []);

    // التحقق من وجود المنتجات
    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('price name nameEn unit unitEn department')
      .populate('department', 'name nameEn code')
      .lean()
      .session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Some products not found:`, { productIds, found: products.map(p => p._id), userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' 
      });
    }

    // التحقق من مطابقة الأسعار
    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.product.toString());
      if (product.price !== item.price) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Price mismatch for product:`, { productId: item.product, expected: product.price, provided: item.price, userId: req.user.id });
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? `السعر غير متطابق للمنتج ${item.product}` : `Price mismatch for product ${item.product}` 
        });
      }
    }

    // إنشاء الطلب الجديد
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);
    const newOrder = new Order({
      orderNumber: orderNumber.trim(),
      branch,
      items: mergedItems,
      status,
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || notes?.trim() || '',
      priority: priority?.trim() || 'medium',
      createdBy: req.user.id,
      totalAmount,
      adjustedTotal: totalAmount,
      requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
      statusHistory: [{
        status,
        changedBy: req.user.id,
        notes: notes?.trim() || (isRtl ? 'تم إنشاء الطلب' : 'Order created'),
        notesEn: notesEn?.trim() || 'Order created',
        changedAt: new Date(),
      }],
    });

    // التحقق من رقم الطلب الفريد
    const existingOrder = await Order.findOne({ orderNumber: newOrder.orderNumber, branch }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Duplicate order number:`, { orderNumber, branch, userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'رقم الطلب مستخدم بالفعل لهذا الفرع' : 'Order number already used for this branch' 
      });
    }

    // حفظ الطلب
    await newOrder.save({ session });
    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    // جلب بيانات الطلب مع التفاصيل
    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name nameEn')
      .populate({ 
        path: 'items.product', 
        select: 'name nameEn price unit unitEn department', 
        populate: { path: 'department', select: 'name nameEn code' } 
      })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .lean();

    // إعداد بيانات الإشعار
    const io = req.app.get('io');
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const eventId = `${newOrder._id}-orderCreated`;
    const notificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      totalQuantity,
      totalAmount,
      items: populatedOrder.items.map(item => ({
        productId: item.product?._id,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        quantity: item.quantity,
        price: item.price,
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      })),
      status: newOrder.status,
      priority: newOrder.priority,
      requestedDeliveryDate: newOrder.requestedDeliveryDate ? new Date(newOrder.requestedDeliveryDate).toISOString() : null,
      eventId,
      isRtl,
    };

    // إرسال الإشعارات للأدمن، الإنتاج، والفرع
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean().session(session);

    await Promise.all([
      ...adminUsers.map(user => createNotification(
        user._id,
        'orderCreated',
        isRtl ? `تم إنشاء طلب رقم ${newOrder.orderNumber} من فرع ${populatedOrder.branch?.name || 'غير معروف'}` : 
                `Order ${newOrder.orderNumber} created from branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
        { ...notificationData, type: 'persistent' },
        io,
        true
      )),
      ...productionUsers.map(user => createNotification(
        user._id,
        'orderCreated',
        isRtl ? `تم إنشاء طلب رقم ${newOrder.orderNumber} من فرع ${populatedOrder.branch?.name || 'غير معروف'}` : 
                `Order ${newOrder.orderNumber} created from branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
        { ...notificationData, type: 'persistent' },
        io,
        true
      )),
      ...branchUsers.map(user => createNotification(
        user._id,
        'orderCreated',
        isRtl ? `تم إنشاء طلبك رقم ${newOrder.orderNumber} بنجاح` : 
                `Order ${newOrder.orderNumber} created successfully`,
        { ...notificationData, type: 'toast' },
        io,
        false
      )),
    ]);

    // تنسيق البيانات للإرسال في الاستجابة
    const orderData = {
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      displayNotes: isRtl ? populatedOrder.notes : (populatedOrder.notesEn || populatedOrder.notes || ''),
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: isRtl ? item.returnReason : (item.returnReason || ''),
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'Unknown'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: isRtl ? history.notes : (history.notesEn || history.notes || ''),
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      requestedDeliveryDate: populatedOrder.requestedDeliveryDate ? new Date(populatedOrder.requestedDeliveryDate).toISOString() : null,
      isRtl,
    };

    await session.commitTransaction();
    console.log(`[${new Date().toISOString()}] Order created successfully:`, { orderId: newOrder._id, orderNumber, userId: req.user.id });
    res.status(201).json({
      success: true,
      data: orderData,
      message: isRtl ? 'تم إنشاء الطلب بنجاح' : 'Order created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: isRtl ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
};

const checkOrderExists = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in checkOrderExists:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getOrders = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, branch, priority } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (priority) query.priority = priority;
    if (req.user.role === 'branch') query.branch = req.user.branchId;
    console.log(`[${new Date().toISOString()}] Fetching orders with query:`, { query, userId: req.user.id, role: req.user.role });
    const orders = await Order.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .sort({ createdAt: -1 })
      .lean();
    console.log(`[${new Date().toISOString()}] Found ${orders.length} orders`);
    const formattedOrders = orders.map(order => ({
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
      displayNotes: isRtl ? order.notes : (order.notesEn || order.notes || ''),
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: isRtl ? item.returnReason : (item.returnReason || ''),
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'Unknown'),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: isRtl ? history.notes : (history.notesEn || history.notes || ''),
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
      isRtl,
    }));
    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    console.log(`[${new Date().toISOString()}] Fetching order by ID: ${id}, User: ${req.user.id}`);
    const order = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch?._id,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    const formattedOrder = {
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
      displayNotes: isRtl ? order.notes : (order.notesEn || order.notes || ''),
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: isRtl ? item.returnReason : (item.returnReason || ''),
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'Unknown'),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: isRtl ? history.notes : (history.notesEn || history.notes || ''),
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
      isRtl,
    };
    console.log(`[${new Date().toISOString()}] Order fetched successfully: ${id}`);
    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  checkOrderExists,
  createOrder,
  getOrders,
  getOrderById,
  createReturn,
  approveReturn,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
};