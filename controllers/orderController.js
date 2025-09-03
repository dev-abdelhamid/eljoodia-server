const mongoose = require('mongoose');

const Order = require('../models/Order');

const User = require('../models/User');

const Product = require('../models/Product');

const Inventory = require('../models/Inventory');

const ProductionAssignment = require('../models/ProductionAssignment');

const Return = require('../models/Return');

const { createNotification } = require('../utils/notifications');

const { syncOrderTasks } = require('./productionController');

// Utility to generate order number in YYYYMMDD-XXXX format

const generateOrderNumber = async (date = new Date()) => {

  const year = date.getFullYear();

  const month = String(date.getMonth() + 1).padStart(2, '0');

  const day = String(date.getDate()).padStart(2, '0');

  const prefix = `${year}${month}${day}`;

  // Find the last order or return created on this date

  const lastOrder = await Order.findOne({ orderNumber: { $regex: `^${prefix}-` } })

    .sort({ orderNumber: -1 })

    .select('orderNumber')

    .lean();

  const lastReturn = await Return.findOne({ orderNumber: { $regex: `^${prefix}-` } })

    .sort({ orderNumber: -1 })

    .select('orderNumber')

    .lean();

  let sequence = 1;

  const lastNumber = [lastOrder, lastReturn]

    .filter(Boolean)

    .map(doc => parseInt(doc.orderNumber.split('-')[1] || '0', 10))

    .sort((a, b) => b - a)[0] || 0;

  sequence = lastNumber + 1;

  return `${prefix}-${String(sequence).padStart(4, '0')}`;

};

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

const emitSocketEvent = async (io, rooms, eventName, eventData) => {

  const soundTypeMap = {

    orderCreated: 'new_order',

    orderApproved: 'order_approved',

    newProductionAssignedToChef: 'task_assigned',

    orderCompleted: 'order_completed',

    orderInTransitToBranch: 'order_in_transit',

    orderDelivered: 'order_delivered',

    returnStatusUpdated: 'return_updated',

    orderStatusUpdated: 'order_status_updated',

  };

  const soundType = soundTypeMap[eventName] || 'notification';

  const eventDataWithSound = {

    ...eventData,

    sound: `https://eljoodia-client.vercel.app/sounds/${soundType}.mp3`,

    vibrate: [200, 100, 200],

    timestamp: new Date().toISOString(),

    eventId: eventData.eventId || `${eventName}-${Date.now()}`,

  };

  const uniqueRooms = new Set(rooms);

  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));

  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {

    rooms: [...uniqueRooms],

    eventData: eventDataWithSound,

  });

};

// التحقق من وجود الطلب

const checkOrderExists = async (req, res) => {

  try {

    const { id } = req.params;

    if (!isValidObjectId(id)) {

      console.error(`[${new Date().toISOString()}] Invalid order ID in checkOrderExists: ${id}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });

    }

    const order = await Order.findById(id).select('_id orderNumber status branch').lean();

    if (!order) {

      console.error(`[${new Date().toISOString()}] Order not found in checkOrderExists: ${id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {

      console.error(`[${new Date().toISOString()}] Unauthorized branch access in checkOrderExists:`, {

        userBranch: req.user.branchId,

        orderBranch: order.branch,

        userId: req.user.id,

      });

      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });

    }

    res.status(200).json({ success: true, orderId: id, exists: true });

  } catch (err) {

    console.error(`[${new Date().toISOString()}] Error checking order existence:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

  }

};

// إنشاء طلب

const createOrder = async (req, res) => {

  const session = await mongoose.startSession();

  try {

    session.startTransaction();

    const { items, status = 'pending', notes, priority = 'medium', branchId } = req.body;

    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;

    if (!branch || !isValidObjectId(branch)) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, userId: req.user.id });

      return res.status(400).json({ success: false, message: 'معرف الفرع مطلوب ويجب أن يكون صالحًا' });

    }

    if (!items?.length) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Missing items:`, { items, userId: req.user.id });

      return res.status(400).json({ success: false, message: 'مصفوفة العناصر مطلوبة' });

    }

    const orderNumber = await generateOrderNumber();

    const mergedItems = items.reduce((acc, item) => {

      if (!isValidObjectId(item.product)) {

        throw new Error(`معرف المنتج غير صالح: ${item.product}`);

      }

      const existing = acc.find(i => i.product.toString() === item.product.toString());

      if (existing) existing.quantity += item.quantity;

      else acc.push({ ...item, status: 'pending', startedAt: null, completedAt: null });

      return acc;

    }, []);

    const products = await Product.find({ _id: { $in: mergedItems.map(i => i.product) } }).lean();

    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    const newOrder = new Order({

      orderNumber,

      branch,

      items: mergedItems.map(item => {

        const product = productMap.get(item.product.toString());

        return {

          product: item.product,

          quantity: item.quantity,

          price: product?.price || item.price || 0,

          status: 'pending',

        };

      }),

      status,

      notes: notes?.trim(),

      priority,

      createdBy: req.user.id,

      totalAmount: mergedItems.reduce((sum, item) => {

        const product = productMap.get(item.product.toString());

        return sum + item.quantity * (product?.price || item.price || 0);

      }, 0),

      adjustedTotal: mergedItems.reduce((sum, item) => {

        const product = productMap.get(item.product.toString());

        return sum + item.quantity * (product?.price || item.price || 0);

      }, 0),

      statusHistory: [{ status, changedBy: req.user.id, changedAt: new Date().toISOString() }],

    });

    await newOrder.save({ session });

    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .session(session)

      .lean();

    const io = req.app.get('io');

    const usersToNotify = await User.find({ 

      $or: [

        { role: { $in: ['admin', 'production'] } },

        { role: 'branch', branch }

      ]

    }).select('_id role branch').lean();

    for (const user of usersToNotify) {

      await createNotification(

        user._id,

        'new_order_from_branch',

        `طلب جديد ${orderNumber} تم إنشاؤه بواسطة ${populatedOrder.createdBy?.username || 'Unknown'} للفرع ${populatedOrder.branch?.name || 'Unknown'}`,

        { orderId: newOrder._id, orderNumber, branchId: branch, eventId: `${newOrder._id}-new_order_from_branch` },

        io

      );

    }

    const orderData = {

      _id: newOrder._id,

      orderNumber,

      branch: { _id: branch, name: populatedOrder.branch?.name || 'Unknown' },

      items: populatedOrder.items,

      status,

      notes: notes?.trim(),

      priority,

      totalAmount: newOrder.totalAmount,

      adjustedTotal: newOrder.adjustedTotal,

      createdBy: populatedOrder.createdBy,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

      statusHistory: populatedOrder.statusHistory,

      eventId: `${newOrder._id}-new_order_from_branch`,

    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'newOrderFromBranch', orderData);

    await session.commitTransaction();

    res.status(201).json(orderData);

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error creating order:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

  } finally {

    session.endSession();

  }

};

// استرجاع الطلبات

const getOrders = async (req, res) => {

  try {

    const { status, branch, priority } = req.query;

    const query = {};

    if (status) query.status = status;

    if (branch && isValidObjectId(branch)) query.branch = branch;

    if (priority) query.priority = priority;

    if (req.user.role === 'branch') query.branch = req.user.branchId;

    console.log(`[${new Date().toISOString()}] Fetching orders with query:`, { query, userId: req.user.id, role: req.user.role });

    const orders = await Order.find(query)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .sort({ createdAt: -1 })

      .lean();

    console.log(`[${new Date().toISOString()}] Found ${orders.length} orders`);

    const formattedOrders = orders.map(order => ({

      _id: order._id,

      orderNumber: order.orderNumber,

      branch: order.branch,

      items: order.items.map(item => ({

        ...item,

        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,

        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,

        isCompleted: item.status === 'completed',

      })),

      returns: order.returns,

      status: order.status,

      totalAmount: order.totalAmount,

      adjustedTotal: order.adjustedTotal,

      createdAt: new Date(order.createdAt).toISOString(),

      notes: order.notes,

      priority: order.priority,

      createdBy: order.createdBy,

      statusHistory: order.statusHistory.map(history => ({

        ...history,

        changedAt: new Date(history.changedAt).toISOString(),

      })),

      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,

      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,

      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,

    }));

    res.status(200).json(formattedOrders);

  } catch (err) {

    console.error(`[${new Date().toISOString()}] Error fetching orders:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

  }

};

// استرجاع طلب معين

const getOrderById = async (req, res) => {

  try {

    const { id } = req.params;

    if (!isValidObjectId(id)) {

      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });

    }

    console.log(`[${new Date().toISOString()}] Fetching order by ID: ${id}, User: ${req.user.id}`);

    const order = await Order.findById(id)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .lean();

    if (!order) {

      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {

      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id, userId: req.user.id });

      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });

    }

    const formattedOrder = {

      _id: order._id,

      orderNumber: order.orderNumber,

      branch: order.branch,

      items: order.items.map(item => ({

        ...item,

        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,

        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,

        isCompleted: item.status === 'completed',

      })),

      returns: order.returns,

      status: order.status,

      totalAmount: order.totalAmount,

      adjustedTotal: order.adjustedTotal,

      createdAt: new Date(order.createdAt).toISOString(),

      notes: order.notes,

      priority: order.priority,

      createdBy: order.createdBy,

      statusHistory: order.statusHistory.map(history => ({

        ...history,

        changedAt: new Date(history.changedAt).toISOString(),

      })),

      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,

      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,

      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,

    };

    console.log(`[${new Date().toISOString()}] Order fetched successfully: ${id}`);

    res.status(200).json(formattedOrder);

  } catch (err) {

    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

  }

};

// إنشاء طلب إرجاع

const createReturn = async (req, res) => {

  const session = await mongoose.startSession();

  try {

    session.startTransaction();

    const { orderId, items, notes } = req.body;

    if (!isValidObjectId(orderId) || !items?.length) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items, userId: req.user.id });

      return res.status(400).json({ success: false, message: 'معرف الطلب ومصفوفة العناصر مطلوبة' });

    }

    const order = await Order.findById(orderId).populate('items.product').session(session);

    if (!order) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch, userId: req.user.id });

      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });

    }

    if (order.status !== 'delivered') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order status for return: ${order.status}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم" لإنشاء طلب إرجاع' });

    }

    for (const item of items) {

      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.product) || !item.quantity || !['defective', 'wrong_item', 'other'].includes(item.reason)) {

        await session.abortTransaction();

        console.error(`[${new Date().toISOString()}] Invalid return item:`, { item, userId: req.user.id });

        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });

      }

      const orderItem = order.items.find(i => i._id.toString() === item.itemId.toString());

      if (!orderItem || orderItem.product._id.toString() !== item.product.toString()) {

        await session.abortTransaction();

        console.error(`[${new Date().toISOString()}] Order item not found or product mismatch:`, { itemId: item.itemId, product: item.product, userId: req.user.id });

        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود أو لا يتطابق مع المنتج` });

      }

      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {

        await session.abortTransaction();

        console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { itemId: item.itemId, requested: item.quantity, available: orderItem.quantity - (orderItem.returnedQuantity || 0), userId: req.user.id });

        return res.status(400).json({ success: false, message: `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${item.itemId}` });

      }

    }

    const orderNumber = await generateOrderNumber();

    const newReturn = new Return({

      order: orderId,

      orderNumber,

      items: items.map(item => ({

        itemId: item.itemId,

        product: item.product,

        quantity: item.quantity,

        reason: item.reason,

      })),

      status: 'pending_approval',

      createdBy: req.user.id,

      createdAt: new Date().toISOString(),

      reviewNotes: notes?.trim(),

    });

    await newReturn.save({ session });

    order.returns.push(newReturn._id);

    await order.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)

      .populate('order', 'orderNumber branch')

      .populate('items.product', 'name')

      .populate('createdBy', 'username')

      .session(session)

      .lean();

    const io = req.app.get('io');

    const usersToNotify = await User.find({ 

      $or: [

        { role: { $in: ['admin', 'production'] } },

        { role: 'branch', branch: order.branch }

      ]

    }).select('_id role branch').lean();

    for (const user of usersToNotify) {

      await createNotification(

        user._id,

        'return_status_updated',

        `تم إنشاء طلب إرجاع جديد ${orderNumber} للطلب ${order.orderNumber}`,

        { returnId: newReturn._id, orderId, orderNumber, branchId: order.branch, eventId: `${newReturn._id}-return_status_updated` },

        io

      );

    }

    const returnData = {

      returnId: newReturn._id,

      orderId,

      orderNumber,

      status: 'pending_approval',

      branchId: order.branch,

      branchName: populatedReturn.order?.branch?.name || 'Unknown',

      items: populatedReturn.items,

      createdAt: new Date(populatedReturn.createdAt).toISOString(),

      eventId: `${newReturn._id}-return_status_updated`,

    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnStatusUpdated', returnData);

    await session.commitTransaction();

    res.status(201).json(returnData);

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

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

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid return ID: ${id}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });

    }

    const returnRequest = await Return.findById(id).populate('order').populate('items.product').session(session);

    if (!returnRequest) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Return not found: ${id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });

    }

    if (!['approved', 'rejected'].includes(status)) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid return status: ${status}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });

    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized return approval:`, { userId: req.user.id, role: req.user.role });

      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع' });

    }

    const order = await Order.findById(returnRequest.order._id).session(session);

    if (!order) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Order not found for return: ${returnRequest.order._id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    let adjustedTotal = order.adjustedTotal;

    if (status === 'approved') {

      for (const returnItem of returnRequest.items) {

        const orderItem = order.items.id(returnItem.itemId);

        if (!orderItem) {

          await session.abortTransaction();

          console.error(`[${new Date().toISOString()}] Order item not found for return: ${returnItem.itemId}, User: ${req.user.id}`);

          return res.status(400).json({ success: false, message: `العنصر ${returnItem.itemId} غير موجود في الطلب` });

        }

        if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {

          await session.abortTransaction();

          console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { itemId: returnItem.itemId, requested: returnItem.quantity, available: orderItem.quantity - (orderItem.returnedQuantity || 0), userId: req.user.id });

          return res.status(400).json({ success: false, message: `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${returnItem.itemId}` });

        }

        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;

        orderItem.returnReason = returnItem.reason;

        adjustedTotal -= returnItem.quantity * orderItem.price;

        await Inventory.findOneAndUpdate(

          { branch: returnRequest.order?.branch, product: returnItem.product },

          { $inc: { currentStock: returnItem.quantity } },

          { upsert: true, session }

        );

      }

      order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;

      order.markModified('items');

      await order.save({ session });

    }

    returnRequest.status = status;

    returnRequest.reviewNotes = reviewNotes?.trim();

    returnRequest.reviewedBy = req.user.id;

    returnRequest.reviewedAt = new Date().toISOString();

    await returnRequest.save({ session });

    const populatedOrder = await Order.findById(returnRequest.order._id)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .session(session)

      .lean();

    const io = req.app.get('io');

    const usersToNotify = await User.find({ 

      $or: [

        { role: { $in: ['admin', 'production'] } },

        { role: 'branch', branch: returnRequest.order?.branch }

      ]

    }).select('_id role branch').lean();

    for (const user of usersToNotify) {

      await createNotification(

        user._id,

        'return_status_updated',

        `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع ${returnRequest.orderNumber} للطلب ${returnRequest.order?.orderNumber || 'Unknown'}`,

        { returnId: id, orderId: returnRequest.order?._id, orderNumber: returnRequest.orderNumber, branchId: returnRequest.order?.branch, eventId: `${id}-return_status_updated` },

        io

      );

    }

    const populatedReturn = await Return.findById(id)

      .populate('order', 'orderNumber branch')

      .populate('items.product', 'name')

      .populate('createdBy', 'username')

      .populate('reviewedBy', 'username')

      .lean();

    const returnData = {

      returnId: id,

      orderId: returnRequest.order?._id,

      orderNumber: returnRequest.orderNumber,

      status,

      reviewNotes,

      branchId: returnRequest.order?.branch,

      branchName: populatedReturn.order?.branch?.name || 'Unknown',

      items: populatedReturn.items,

      createdAt: new Date(populatedReturn.createdAt).toISOString(),

      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,

      adjustedTotal: populatedOrder.adjustedTotal,

      eventId: `${id}-return_status_updated`,

    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.order?.branch}`], 'returnStatusUpdated', returnData);

    await session.commitTransaction();

    res.status(200).json({ ...populatedReturn, adjustedTotal: populatedOrder.adjustedTotal });

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

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

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items, userId: req.user.id });

      return res.status(400).json({ success: false, message: 'معرف الطلب أو مصفوفة العناصر غير صالحة' });

    }

    const order = await Order.findById(orderId)

      .populate({ path: 'items.product', populate: { path: 'department', select: 'name code isActive' } })

      .populate('branch')

      .session(session);

    if (!order) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch?._id, userId: req.user.id });

      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });

    }

    if (order.status !== 'approved' && order.status !== 'in_production') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order status for assigning chefs: ${order.status}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' });

    }

    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);

    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();

    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();

    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));

    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));

    const io = req.app.get('io');

    const assignments = [];

    const taskAssignedEvents = [];

    const itemStatusEvents = [];

    for (const item of items) {

      const itemId = item.itemId || item._id;

      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {

        throw new Error(`معرفات غير صالحة: ${itemId}, ${item.assignedTo}`);

      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);

      if (!orderItem) {

        throw new Error(`العنصر ${itemId} غير موجود`);

      }

      const existingTask = await ProductionAssignment.findOne({ order: orderId, itemId }).session(session);

      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {

        throw new Error('لا يمكن إعادة تعيين المهمة لشيف آخر');

      }

      const chef = chefMap.get(item.assignedTo);

      const chefProfile = chefProfileMap.get(item.assignedTo);

      if (!chef || !chefProfile) {

        throw new Error('الشيف غير صالح');

      }

      orderItem.assignedTo = item.assignedTo;

      orderItem.status = 'assigned';

      assignments.push(ProductionAssignment.findOneAndUpdate(

        { order: orderId, itemId },

        { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },

        { upsert: true, session }

      ));

      taskAssignedEvents.push({

        _id: itemId,

        order: { _id: orderId, orderNumber: order.orderNumber },

        product: { _id: orderItem.product._id, name: orderItem.product.name, department: orderItem.product.department },

        chefId: item.assignedTo,

        chefName: chef.username || 'غير معروف',

        quantity: orderItem.quantity,

        itemId,

        status: 'assigned',

        branchId: order.branch?._id,

        branchName: order.branch?.name || 'غير معروف',

        eventId: `${itemId}-new_production_assigned_to_chef`,

      });

      itemStatusEvents.push({

        orderId,

        itemId,

        status: 'assigned',

        productName: orderItem.product.name,

        orderNumber: order.orderNumber,

        branchId: order.branch?._id,

        branchName: order.branch?.name || 'غير معروف',

        eventId: `${itemId}-item_status_updated`,

      });

    }

    await Promise.all(assignments);

    const usersToNotify = await User.find({ _id: { $in: items.map(i => i.assignedTo) } }).select('_id').lean();

    await Promise.all(usersToNotify.map(user => 

      createNotification(

        user._id,

        'new_production_assigned_to_chef',

        `تم تعيينك لإنتاج عنصر في الطلب ${order.orderNumber}`,

        { orderId, orderNumber: order.orderNumber, branchId: order.branch?._id, chefId: user._id, eventId: `${orderId}-new_production_assigned_to_chef` },

        io

      )

    ));

    order.status = order.items.every(item => item.status === 'assigned') ? 'in_production' : order.status;

    order.markModified('items');

    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    const populatedOrder = await Order.findById(orderId)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('returns')

      .lean();

    await Promise.all([

      ...taskAssignedEvents.map(event => 

        emitSocketEvent(io, [

          `chef-${event.chefId}`,

          `branch-${order.branch?._id}`,

          'production',

          'admin',

        ], 'newProductionAssignedToChef', event)

      ),

      ...itemStatusEvents.map(event => 

        emitSocketEvent(io, [`branch-${order.branch?._id}`, 'production', 'admin'], 'itemStatusUpdated', event)

      ),

      emitSocketEvent(io, ['production', 'admin', `branch-${order.branch?._id}`], 'orderUpdated', {

        ...populatedOrder,

        branchId: order.branch?._id,

        branchName: order.branch?.name || 'غير معروف',

        adjustedTotal: populatedOrder.adjustedTotal,

        createdAt: new Date(populatedOrder.createdAt).toISOString(),

        eventId: `${orderId}-order_updated`,

      })

    ]);

    await session.commitTransaction();

    res.status(200).json({

      ...populatedOrder,

      branchId: order.branch?._id,

      branchName: order.branch?.name || 'غير معروف',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

    });

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

  } finally {

    session.endSession();

  }

};

// اعتماد الطلب

const approveOrder = async (req, res) => {

  const session = await mongoose.startSession();

  try {

    session.startTransaction();

    const { id } = req.params;

    if (!isValidObjectId(id)) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });

    }

    const order = await Order.findById(id).session(session);

    if (!order) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (order.status !== 'pending') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order status for approval: ${order.status}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة "معلق"' });

    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized approval attempt:`, { userId: req.user.id, role: req.user.role });

      return res.status(403).json({ success: false, message: 'غير مخول لاعتماد الطلب' });

    }

    order.status = 'approved';

    order.approvedBy = req.user.id;

    order.approvedAt = new Date().toISOString();

    order.statusHistory.push({

      status: 'approved',

      changedBy: req.user.id,

      changedAt: new Date().toISOString(),

    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .session(session)

      .lean();

    const io = req.app.get('io');

    const usersToNotify = await User.find({ 

      $or: [

        { role: { $in: ['admin', 'production'] } },

        { role: 'branch', branch: order.branch }

      ]

    }).select('_id role branch').lean();

    for (const user of usersToNotify) {

      await createNotification(

        user._id,

        'order_approved_for_branch',

        `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`,

        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_approved_for_branch` },

        io

      );

    }

    const orderData = {

      orderId: id,

      orderNumber: order.orderNumber,

      status: 'approved',

      user: { _id: req.user.id, username: req.user.username },

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

      eventId: `${id}-order_approved_for_branch`,

    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApprovedForBranch', orderData);

    await session.commitTransaction();

    res.status(200).json({

      ...populatedOrder,

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

    });

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error approving order:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

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

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });

    }

    const order = await Order.findById(id).session(session);

    if (!order) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (order.status !== 'completed') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order status for transit: ${order.status}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' });

    }

    if (req.user.role !== 'production') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized transit attempt:`, { userId: req.user.id, role: req.user.role });

      return res.status(403).json({ success: false, message: 'غير مخول لبدء التوصيل' });

    }

    order.status = 'in_transit';

    order.transitStartedAt = new Date().toISOString();

    order.statusHistory.push({

      status: 'in_transit',

      changedBy: req.user.id,

      changedAt: new Date().toISOString(),

    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .session(session)

      .lean();

    const io = req.app.get('io');

    const usersToNotify = await User.find({ 

      $or: [

        { role: { $in: ['admin', 'production'] } },

        { role: 'branch', branch: order.branch }

      ]

    }).select('_id role branch').lean();

    for (const user of usersToNotify) {

      await createNotification(

        user._id,

        'order_in_transit_to_branch',

        `الطلب ${order.orderNumber} في طريقه إلى ${populatedOrder.branch?.name || 'Unknown'}`,

        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_in_transit_to_branch` },

        io

      );

    }

    const orderData = {

      orderId: id,

      orderNumber: order.orderNumber,

      status: 'in_transit',

      user: { _id: req.user.id, username: req.user.username },

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

      eventId: `${id}-order_in_transit_to_branch`,

    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransitToBranch', orderData);

    await session.commitTransaction();

    res.status(200).json({

      ...populatedOrder,

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

    });

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error starting transit:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

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

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });

    }

    const order = await Order.findById(id).session(session);

    if (!order) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (order.status !== 'in_transit') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order status for delivery confirmation: ${order.status}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "في الطريق" لتأكيد التسليم' });

    }

    if (req.user.role !== 'branch' || order.branch?.toString() !== req.user.branchId.toString()) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized delivery confirmation:`, { userId: req.user.id, role: req.user.role, userBranch: req.user.branchId, orderBranch: order.branch });

      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد تسليم هذا الطلب' });

    }

    order.status = 'delivered';

    order.deliveredAt = new Date().toISOString();

    order.statusHistory.push({

      status: 'delivered',

      changedBy: req.user.id,

      changedAt: new Date().toISOString(),

    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .session(session)

      .lean();

    const io = req.app.get('io');

    const usersToNotify = await User.find({ 

      $or: [

        { role: { $in: ['admin', 'production'] } },

        { role: 'branch', branch: order.branch }

      ]

    }).select('_id role branch').lean();

    for (const user of usersToNotify) {

      await createNotification(

        user._id,

        'order_delivered',

        `تم تسليم الطلب ${order.orderNumber} إلى الفرع ${populatedOrder.branch?.name || 'Unknown'}`,

        { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_delivered` },

        io

      );

    }

    const orderData = {

      orderId: id,

      orderNumber: order.orderNumber,

      status: 'delivered',

      user: { _id: req.user.id, username: req.user.username },

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

      eventId: `${id}-order_delivered`,

    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', orderData);

    await session.commitTransaction();

    res.status(200).json({

      ...populatedOrder,

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

    });

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

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

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);

      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });

    }

    const order = await Order.findById(id).session(session);

    if (!order) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);

      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    }

    if (!validateStatusTransition(order.status, status)) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Invalid status transition:`, { current: order.status, new: status, userId: req.user.id });

      return res.status(400).json({ success: false, message: `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` });

    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, orderBranch: order.branch, userId: req.user.id });

      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });

    }

    if (req.user.role === 'branch' && status !== 'delivered') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized status update by branch:`, { userId: req.user.id, status });

      return res.status(403).json({ success: false, message: 'الفرع مخول فقط لتحديث الحالة إلى "تم التسليم"' });

    }

    if (['approved', 'in_production', 'completed', 'in_transit'].includes(status) && req.user.role !== 'admin' && req.user.role !== 'production') {

      await session.abortTransaction();

      console.error(`[${new Date().toISOString()}] Unauthorized status update:`, { userId: req.user.id, role: req.user.role, status });

      return res.status(403).json({ success: false, message: `غير مخول لتحديث الحالة إلى ${status}` });

    }

    if (status === 'delivered') {

      order.deliveredAt = new Date().toISOString();

    } else if (status === 'in_transit') {

      order.transitStartedAt = new Date().toISOString();

    } else if (status === 'approved') {

      order.approvedAt = new Date().toISOString();

      order.approvedBy = req.user.id;

    }

    order.status = status;

    order.statusHistory.push({

      status,

      changedBy: req.user.id,

      changedAt: new Date().toISOString(),

      notes: notes?.trim(),

    });

    await order.save({ session });

    const populatedOrder = await Order.findById(id)

      .populate('branch', 'name')

      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })

      .populate('items.assignedTo', 'username')

      .populate('createdBy', 'username')

      .populate('returns')

      .session(session)

      .lean();

    const io = req.app.get('io');

    const usersToNotify = await User.find({ 

      $or: [

        { role: { $in: ['admin', 'production'] } },

        { role: 'branch', branch: order.branch }

      ]

    }).select('_id role branch').lean();

    let notificationType = 'order_status_updated';

    let notificationMessage = `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`;

    

    if (status === 'delivered') {

      notificationType = 'order_delivered';

      notificationMessage = `تم تسليم الطلب ${order.orderNumber} إلى ${populatedOrder.branch?.name || 'Unknown'}`;

    } else if (status === 'in_transit') {

      notificationType= 'order_in_transit_to_branch';

      notificationMessage = `الطلب ${order.orderNumber} في طريقه إلى ${populatedOrder.branch?.name || 'Unknown'}`;

    } else if (status === 'approved') {

      notificationType = 'order_approved_for_branch';

      notificationMessage = `تم اعتماد الطلب ${order.orderNumber} بواسطة ${req.user.username}`;

    }

    for (const user of usersToNotify) {

      await createNotification(

        user._id,

        notificationType,

        notificationMessage,

        { 

          orderId: id, 

          orderNumber: order.orderNumber, 

          branchId: order.branch, 

          eventId: `${id}-${notificationType}` 

        },

        io

      );

    }

    const orderData = {

      orderId: id,

      orderNumber: order.orderNumber,

      status,

      user: { _id: req.user.id, username: req.user.username },

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

      notes: notes?.trim(),

      eventId: `${id}-${notificationType}`,

    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], notificationType, orderData);

    await session.commitTransaction();

    res.status(200).json({

      ...populatedOrder,

      branchId: order.branch,

      branchName: populatedOrder.branch?.name || 'Unknown',

      adjustedTotal: populatedOrder.adjustedTotal,

      createdAt: new Date(populatedOrder.createdAt).toISOString(),

    });

  } catch (err) {

    await session.abortTransaction();

    console.error(`[${new Date().toISOString()}] Error updating order status:`, { error: err.message, userId: req.user.id });

    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });

  } finally {

    session.endSession();

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

};    
