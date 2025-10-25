const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');
const { createReturn, approveReturn } = require('./returnController');
const { assignChefs, approveOrder, startTransit, updateOrderStatus, confirmOrderReceipt } = require('./statusController');

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

const notifyUsers = async (io, users, type, messageKey, data, saveToDb = false) => {
  const isRtl = data.isRtl ?? true;
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, status = 'pending', notes, notesEn, priority = 'medium', branchId, requestedDeliveryDate } = req.body;

    // Validate input data
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

    // Validate items
    const productIds = items.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).select('price name nameEn unit unitEn department').populate('department', 'name nameEn code').lean().session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Some products not found:`, { productIds, found: products.map(p => p._id), userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' 
      });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || typeof item.quantity !== 'number' || item.quantity <= 0 || typeof item.price !== 'number' || item.price < 0) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid item data:`, { item, userId: req.user.id });
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? 'بيانات العنصر غير صالحة (معرف المنتج، الكمية، أو السعر)' : 'Invalid item data (product ID, quantity, or price)' 
        });
      }
      const product = products.find(p => p._id.toString() === item.product.toString());
      if (!product) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Product not found for item:`, { item, userId: req.user.id });
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? `المنتج ${item.product} غير موجود` : `Product ${item.product} not found` 
        });
      }
      // Validate quantity based on unit
      const isKgUnit = product.unit === 'كيلو' || product.unitEn === 'Kilo';
      if (isKgUnit) {
        if (item.quantity < 0.5 || item.quantity % 0.5 !== 0) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid quantity for kilogram product:`, { item, productName: product.name, userId: req.user.id });
          return res.status(400).json({ 
            success: false, 
            message: isRtl ? `الكمية يجب أن تكون مضاعفات 0.5 للمنتج ${product.name}` : `Quantity must be in increments of 0.5 for product ${product.nameEn || product.name}` 
          });
        }
      } else {
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid quantity for non-kilogram product:`, { item, productName: product.name, userId: req.user.id });
          return res.status(400).json({ 
            success: false, 
            message: isRtl ? `الكمية يجب أن تكون عددًا صحيحًا للمنتج ${product.name}` : `Quantity must be an integer for product ${product.nameEn || product.name}` 
          });
        }
      }
      // Verify price matching
      if (product.price !== item.price) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Price mismatch for product:`, { productId: item.product, expected: product.price, provided: item.price, userId: req.user.id });
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? `السعر غير متطابق للمنتج ${item.product}` : `Price mismatch for product ${item.product}` 
        });
      }
    }

    // Merge duplicate items by product ID
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

    // Re-validate merged quantities
    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.product.toString());
      const isKgUnit = product.unit === 'كيلو' || product.unitEn === 'Kilo';
      if (isKgUnit && (item.quantity < 0.5 || item.quantity % 0.5 !== 0)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid merged quantity for kilogram product:`, { item, productName: product.name, userId: req.user.id });
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? `الكمية المجمعة يجب أن تكون مضاعفات 0.5 للمنتج ${product.name}` : `Merged quantity must be in increments of 0.5 for product ${product.nameEn || product.name}` 
        });
      }
      if (!isKgUnit && (!Number.isInteger(item.quantity) || item.quantity < 1)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid merged quantity for non-kilogram product:`, { item, productName: product.name, userId: req.user.id });
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? `الكمية المجمعة يجب أن تكون عددًا صحيحًا للمنتج ${product.name}` : `Merged quantity must be an integer for product ${product.nameEn || product.name}` 
        });
      }
    }

    // Create new order
    const newOrder = new Order({
      orderNumber: orderNumber.trim(),
      branch,
      items: mergedItems,
      status,
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || notes?.trim() || '',
      priority: priority?.trim() || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
      statusHistory: [{
        status,
        changedBy: req.user.id,
        notes: notes?.trim() || (isRtl ? 'تم إنشاء الطلب' : 'Order created'),
        notesEn: notesEn?.trim() || 'Order created',
        changedAt: new Date(),
      }],
    });

    // Check for duplicate order number
    const existingOrder = await Order.findOne({ orderNumber: newOrder.orderNumber, branch }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Duplicate order number:`, { orderNumber, branch, userId: req.user.id });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'رقم الطلب مستخدم بالفعل لهذا الفرع' : 'Order number already used for this branch' 
      });
    }

    // Save the order
    await newOrder.save({ session, context: { isRtl } });
    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    // Fetch order details
    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    // Prepare socket notifications
    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean().session(session);

    const eventId = `${newOrder._id}-orderCreated`;
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    // Notify branch (toast only, no DB save)
    const branchNotificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      eventId,
      isRtl,
      type: 'toast',
    };

    await notifyUsers(
      io,
      branchUsers,
      'orderCreated',
      isRtl ? `تم إنشاء طلبك رقم ${newOrder.orderNumber} بنجاح` : `Order ${newOrder.orderNumber} created successfully`,
      branchNotificationData,
      false
    );

    // Notify admin and production (persistent, saved to DB)
    const adminProductionNotificationData = {
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
      type: 'persistent',
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers],
      'orderCreated',
      isRtl ? `تم إنشاء طلب رقم ${newOrder.orderNumber} بقيمة ${totalAmount} وكمية ${totalQuantity} من فرع ${populatedOrder.branch?.name || 'غير معروف'}` : 
            `Order ${newOrder.orderNumber} created with value ${totalAmount} and quantity ${totalQuantity} from branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      adminProductionNotificationData,
      true
    );

    // Prepare order data for socket emission
    const orderData = {
      ...populatedOrder,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: item.displayReturnReason,
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
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      requestedDeliveryDate: populatedOrder.requestedDeliveryDate ? new Date(populatedOrder.requestedDeliveryDate).toISOString() : null,
      eventId,
      isRtl,
    };

    // Emit socket event for new order
    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'orderCreated', orderData);

    await session.commitTransaction();
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

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await Order.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "في الطريق"' : 'Order must be in "in_transit" status' });
    }
    // Update inventory
    for (const item of order.items) {
      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        {
          $inc: { currentStock: item.quantity },
          $push: {
            movements: {
              type: 'in',
              quantity: item.quantity,
              reference: `تسليم طلب #${order.orderNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { new: true, upsert: true, session }
      );
      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: order.branch,
        action: 'delivery',
        quantity: item.quantity,
        reference: `تسليم طلب #${order.orderNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }
    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      notes: isRtl ? 'تم تأكيد التسليم من قبل الفرع' : 'Delivery confirmed by branch',
      notesEn: 'Delivery confirmed by branch',
      changedAt: new Date(),
    });
    await order.save({ session });
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn' })
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();
    await notifyUsers(
      io,
      usersToNotify,
      'order_status_updated',
      'notifications.order_status_updated',
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, status: 'delivered', eventId: `${id}-order_status_updated`, isRtl }
    );
    const orderData = {
      orderId: id,
      orderNumber: order.orderNumber,
      status: 'delivered',
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : populatedOrder.branch?.nameEn || 'Unknown',
      items: populatedOrder.items,
      deliveredAt: new Date(order.deliveredAt).toISOString(),
      eventId: `${id}-order_status_updated`,
      isRtl,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', orderData);
    await session.commitTransaction();
    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
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
    const order = await Order.findById(id).select('_id orderNumber status branch').setOptions({ context: { isRtl } }).lean();
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
      .setOptions({ context: { isRtl } })
      .sort({ createdAt: -1 })
      .lean();
    console.log(`[${new Date().toISOString()}] Found ${orders.length} orders`);
    const formattedOrders = orders.map(order => ({
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: item.displayReturnReason,
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
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      requestedDeliveryDate: order.requestedDeliveryDate ? new Date(order.requestedDeliveryDate).toISOString() : null,
      isRtl,
    }));
    res.status(200).json({ success: true, data: formattedOrders });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getOrder = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in getOrder: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in getOrder: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in getOrder:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    const formattedOrder = {
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'Unknown'),
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: item.displayReturnReason,
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
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      requestedDeliveryDate: order.requestedDeliveryDate ? new Date(order.requestedDeliveryDate).toISOString() : null,
      isRtl,
    };
    res.status(200).json({ success: true, data: formattedOrder });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const updateOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { notes, notesEn, priority, requestedDeliveryDate } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    if (['completed', 'delivered', 'cancelled'].includes(order.status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن تعديل الطلب في هذه الحالة' : 'Cannot update order in this status' });
    }

    const updates = {};
    if (notes) updates.notes = notes.trim();
    if (notesEn) updates.notesEn = notesEn.trim();
    if (priority && ['low', 'medium', 'high', 'urgent'].includes(priority)) {
      updates.priority = priority;
    }
    if (requestedDeliveryDate) {
      updates.requestedDeliveryDate = new Date(requestedDeliveryDate);
    }

    if (Object.keys(updates).length > 0) {
      Object.assign(order, updates);
      order.statusHistory.push({
        status: order.status,
        changedBy: req.user.id,
        notes: isRtl ? `تم تعديل الطلب: ${Object.keys(updates).join(', ')}` : `Order updated: ${Object.keys(updates).join(', ')}`,
        notesEn: `Order updated: ${Object.keys(updates).join(', ')}`,
        changedAt: new Date(),
      });
      await order.save({ session, context: { isRtl } });
    }

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();
    await notifyUsers(
      io,
      usersToNotify,
      'order_updated',
      'notifications.order_updated',
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_updated`, isRtl }
    );

    const orderData = {
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayReturnReason: item.displayReturnReason,
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
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      requestedDeliveryDate: populatedOrder.requestedDeliveryDate ? new Date(populatedOrder.requestedDeliveryDate).toISOString() : null,
      eventId: `${id}-order_updated`,
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderUpdated', orderData);
    await session.commitTransaction();
    res.status(200).json({
      success: true,
      data: orderData,
      message: isRtl ? 'تم تعديل الطلب بنجاح' : 'Order updated successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const deleteOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن حذف الطلب إلا في حالة "معلق"' : 'Order can only be deleted in "pending" status' });
    }

    await Order.deleteOne({ _id: id }).session(session);
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();
    await notifyUsers(
      io,
      usersToNotify,
      'order_deleted',
      'notifications.order_deleted',
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${id}-order_deleted`, isRtl }
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDeleted', {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      eventId: `${id}-order_deleted`,
      isRtl,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, message: isRtl ? 'تم حذف الطلب بنجاح' : 'Order deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error deleting order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createOrder,
  confirmDelivery,
  checkOrderExists,
  getOrders,
  getOrder,
  updateOrder,
  deleteOrder,
  assignChefs,
  approveOrder,
  startTransit,
  updateOrderStatus,
  confirmOrderReceipt,
  createReturn,
  approveReturn,
};