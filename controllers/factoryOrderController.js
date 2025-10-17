const mongoose = require('mongoose');
const FactoryOrder = require('../models/FactoryOrder');
const Product = require('../models/Product');
const User = require('../models/User');
const ProductionAssignment = require('../models/ProductionAssignment');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
};

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

const notifyUsers = async (io, users, type, message, data, saveToDb = false) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const createFactoryOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, notes, notesEn, priority = 'medium' } = req.body;

    if (!orderNumber || !items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing or invalid orderNumber or items:`, { orderNumber, items, userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'رقم الطلب ومصفوفة العناصر مطلوبة ويجب أن تكون صالحة' : 'Order number and items array are required and must be valid' 
      });
    }

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

    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).select('price name nameEn unit unitEn department').populate('department', 'name nameEn code').lean().session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Some products not found:`, { productIds, found: products.map(p => p._id), userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' 
      });
    }

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

    const newFactoryOrder = new FactoryOrder({
      orderNumber: orderNumber.trim(),
      items: mergedItems,
      status: 'pending',
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || notes?.trim() || '',
      priority: priority?.trim() || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      statusHistory: [{
        status: 'pending',
        changedBy: req.user.id,
        notes: notes?.trim() || (isRtl ? 'تم إنشاء طلب إنتاج' : 'Factory order created'),
        notesEn: notesEn?.trim() || 'Factory order created',
        changedAt: new Date(),
      }],
    });

    const existingOrder = await FactoryOrder.findOne({ orderNumber: newFactoryOrder.orderNumber }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Duplicate factory order number:`, { orderNumber, userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'رقم الطلب مستخدم بالفعل' : 'Order number already used' 
      });
    }

    await newFactoryOrder.save({ session, context: { isRtl } });

    const populatedOrder = await FactoryOrder.findById(newFactoryOrder._id)
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);

    const eventId = `${newFactoryOrder._id}-factoryOrderCreated`;
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    const adminProductionNotificationData = {
      orderId: newFactoryOrder._id,
      orderNumber: newFactoryOrder.orderNumber,
      totalQuantity,
      totalAmount,
      items: populatedOrder.items.map(item => ({
        productId: item.product?._id,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        quantity: item.quantity,
        price: item.price,
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      })),
      status: newFactoryOrder.status,
      priority: newFactoryOrder.priority,
      eventId,
      isRtl,
      type: 'persistent',
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers],
      'factoryOrderCreated',
      isRtl ? `تم إنشاء طلب إنتاج رقم ${newFactoryOrder.orderNumber} بقيمة ${totalAmount} وكمية ${totalQuantity}` : 
            `Factory order ${newFactoryOrder.orderNumber} created with value ${totalAmount} and quantity ${totalQuantity}`,
      adminProductionNotificationData,
      true
    );

    const orderData = {
      ...populatedOrder,
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'Unknown'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      totalAmount: populatedOrder.totalAmount,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production'], 'factoryOrderCreated', orderData);

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: orderData,
      message: isRtl ? 'تم إنشاء طلب الإنتاج بنجاح' : 'Factory order created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating factory order:`, {
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

const getFactoryOrders = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, priority } = req.query;
    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    console.log(`[${new Date().toISOString()}] Fetching factory orders with query:`, { query, userId: req.user.id, role: req.user.role });
    const orders = await FactoryOrder.find(query)
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .sort({ createdAt: -1 })
      .lean();
    console.log(`[${new Date().toISOString()}] Found ${orders.length} factory orders`);
    const formattedOrders = orders.map(order => ({
      ...order,
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'Unknown'),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      totalAmount: order.totalAmount,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      isRtl,
    }));
    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory orders:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getFactoryOrderById = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid factory order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    console.log(`[${new Date().toISOString()}] Fetching factory order by ID: ${id}, User: ${req.user.id}`);
    const order = await FactoryOrder.findById(id)
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Factory order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    const formattedOrder = {
      ...order,
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'Unknown'),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      totalAmount: order.totalAmount,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      isRtl,
    };
    console.log(`[${new Date().toISOString()}] Factory order fetched successfully: ${id}`);
    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory order by id:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const assignFactoryChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { items, notes, notesEn } = req.body;
    const { id: orderId } = req.params;
    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو مصفوفة العناصر غير صالحة' : 'Invalid order ID or items array' });
    }
    const order = await FactoryOrder.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name nameEn code isActive' } })
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "معلق" لتعيين الشيفات' : 'Order must be in "pending" status to assign chefs' });
    }
    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));
    const io = req.app.get('io');
    const assignments = [];
    const chefNotifications = [];
    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        throw new Error(isRtl ? `معرفات غير صالحة: ${itemId}, ${item.assignedTo}` : `Invalid IDs: ${itemId}, ${item.assignedTo}`);
      }
      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(isRtl ? `العنصر ${itemId} غير موجود` : `Item ${itemId} not found`);
      }
      const existingTask = await ProductionAssignment.findOne({ factoryOrder: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        throw new Error(isRtl ? 'لا يمكن إعادة تعيين المهمة لشيف آخر' : 'Cannot reassign task to another chef');
      }
      const chef = chefMap.get(item.assignedTo);
      const chefProfile = chefProfileMap.get(item.assignedTo);
      if (!chef || !chefProfile) {
        throw new Error(isRtl ? 'الشيف غير صالح' : 'Invalid chef');
      }
      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      assignments.push(
        ProductionAssignment.findOneAndUpdate(
          { factoryOrder: orderId, itemId },
          { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, factoryOrder: orderId },
          { upsert: true, session }
        )
      );
      chefNotifications.push({
        userId: item.assignedTo,
        message: isRtl ? `تم تعيينك لإنتاج ${orderItem.product.name} في طلب الإنتاج ${order.orderNumber}` : `Assigned to produce ${orderItem.product.nameEn || orderItem.product.name} for factory order ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          taskId: itemId,
          productId: orderItem.product._id,
          productName: isRtl ? orderItem.product.name : (orderItem.product.nameEn || orderItem.product.name),
          quantity: orderItem.quantity,
          eventId: `${itemId}-factory_task_assigned`,
          isRtl,
        },
      });
    }
    await Promise.all(assignments);
    order.markModified('items');
    order.status = 'in_production';
    order.statusHistory.push({
      status: order.status,
      changedBy: req.user.id,
      notes: notes?.trim(),
      notesEn: notesEn?.trim(),
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });
    const populatedOrder = await FactoryOrder.findById(orderId)
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();
    const taskAssignedEventData = {
      _id: `${orderId}-factoryTaskAssigned-${Date.now()}`,
      type: 'factoryTaskAssigned',
      message: isRtl ? `تم تعيين الشيفات بنجاح لطلب الإنتاج ${order.orderNumber}` : `Chefs assigned successfully for factory order ${order.orderNumber}`,
      data: {
        orderId,
        orderNumber: order.orderNumber,
        eventId: `${orderId}-factory_task_assigned`,
        isRtl,
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers],
      'factoryTaskAssigned',
      taskAssignedEventData.message,
      taskAssignedEventData.data,
      false
    );
    for (const chefNotif of chefNotifications) {
      await notifyUsers(
        io,
        [{ _id: chefNotif.userId }],
        'factoryTaskAssigned',
        chefNotif.message,
        chefNotif.data,
        false
      );
    }
    const rooms = new Set(['admin', 'production']);
    chefIds.forEach(chefId => rooms.add(`chef-${chefId}`));
    await emitSocketEvent(io, rooms, 'factoryTaskAssigned', taskAssignedEventData);
    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'غير معروف'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
      })),
      totalAmount: populatedOrder.totalAmount,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      isRtl,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning factory chefs:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateFactoryOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { status } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id).setOptions({ context: { isRtl } }).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` : `Cannot change status from ${order.status} to ${status}` });
    }
    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();
    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id role').lean();
    const eventId = `${id}-factory_order_status_updated-${status}`;
    const eventType = status === 'completed' ? 'factoryOrderCompleted' : 'factoryOrderStatusUpdated';
    const messageKey = status === 'completed'
      ? isRtl ? `تم إكمال طلب الإنتاج ${order.orderNumber}` : `Factory order ${order.orderNumber} completed`
      : isRtl ? `تم تحديث حالة طلب الإنتاج ${order.orderNumber} إلى ${status}` : `Factory order ${order.orderNumber} status updated to ${status}`;
    const saveToDb = status === 'completed';
    await notifyUsers(
      io,
      usersToNotify,
      eventType,
      messageKey,
      { orderId: id, orderNumber: order.orderNumber, status, eventId, isRtl },
      saveToDb
    );
    const orderData = {
      orderId: id,
      status,
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      displayNotes: populatedOrder.displayNotes,
      totalAmount: populatedOrder.totalAmount,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };
    await emitSocketEvent(io, ['admin', 'production'], eventType, orderData);
    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating factory order status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmFactoryProduction = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role !== 'production' && req.user.role !== 'admin') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتأكيد الإنتاج' : 'Unauthorized to confirm production' });
    }
    if (order.status !== 'in_production') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "قيد الإنتاج"' : 'Order must be in "in_production" status' });
    }
    if (!order.items.every(i => i.status === 'completed')) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب إكمال جميع العناصر' : 'All items must be completed' });
    }
    // Update inventory
    for (const item of order.items) {
      const inventoryUpdate = await FactoryInventory.findOneAndUpdate(
        { product: item.product },
        {
          $inc: { currentStock: item.quantity },
          $push: {
            movements: {
              type: 'in',
              quantity: item.quantity,
              reference: `تأكيد إنتاج طلب #${order.orderNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { new: true, upsert: true, session }
      );
      const historyEntry = new FactoryInventoryHistory({
        product: item.product,
        action: 'produced_stock',
        quantity: item.quantity,
        reference: `تأكيد إنتاج طلب #${order.orderNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }
    order.status = 'completed';
    order.statusHistory.push({
      status: 'completed',
      changedBy: req.user.id,
      notes: isRtl ? 'تم تأكيد الإنتاج' : 'Production confirmed',
      notesEn: 'Production confirmed',
      changedAt: new Date(),
    });
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({ path: 'items.product', select: 'name nameEn' })
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id role').lean();
    const eventId = `${id}-factory_order_completed`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      status: 'completed',
      eventId,
      isRtl,
    };
    await notifyUsers(
      io,
      usersToNotify,
      'factoryOrderCompleted',
      isRtl ? `تم إكمال طلب الإنتاج ${order.orderNumber}` : `Factory order ${order.orderNumber} completed`,
      eventData,
      true
    );
    const orderData = {
      orderId: id,
      orderNumber: order.orderNumber,
      status: 'completed',
      items: populatedOrder.items,
      completedAt: new Date(order.deliveredAt).toISOString(),
      eventId: `${id}-factory_order_completed`,
      isRtl,
    };
    await emitSocketEvent(io, ['admin', 'production'], 'factoryOrderCompleted', orderData);
    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming factory production:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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