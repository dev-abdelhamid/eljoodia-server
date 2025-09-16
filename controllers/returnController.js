const mongoose = require('mongoose');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

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
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: uniqueRooms,
    eventData: eventDataWithSound,
  });
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

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, branchId, reason, items, notes } = req.body;

    // Validation
    if (!isValidObjectId(orderId) || !isValidObjectId(branchId) || !reason || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for return:`, { orderId, branchId, reason, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب، معرف الفرع، السبب، ومصفوفة العناصر مطلوبة' });
    }

    // Validate items
    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || item.quantity < 1 || !item.reason) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid return item:`, { item, userId: req.user.id });
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }
    }

    // Fetch order
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    // Check authorization
    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    // Check order status
    if (order.status !== 'delivered') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for return: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم" لإنشاء طلب إرجاع' });
    }

    // Check if order is within 3 days
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    if (new Date(order.createdAt) < threeDaysAgo) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order too old for return:`, { orderId, createdAt: order.createdAt, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' });
    }

    // Validate return items against order items
    for (const item of items) {
      const orderItem = order.items.find(i => i.product._id.toString() === item.product.toString());
      if (!orderItem) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Product not found in order:`, { productId: item.product, orderId, userId: req.user.id });
        return res.status(400).json({ success: false, message: `المنتج ${item.product} غير موجود في الطلب` });
      }
      const availableQuantity = orderItem.quantity - (orderItem.returnedQuantity || 0);
      if (item.quantity > availableQuantity) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid return quantity:`, {
          productId: item.product,
          requested: item.quantity,
          available: availableQuantity,
          userId: req.user.id,
        });
        return res.status(400).json({ success: false, message: `الكمية المطلوب إرجاعها للمنتج ${item.product} تتجاوز الكمية المتاحة` });
      }
    }

    // Generate return number
    const returnCount = await Return.countDocuments().session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

    // Create return
    const newReturn = new Return({
      returnNumber,
      order: orderId,
      branch: branchId,
      reason,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
        status: 'pending_approval',
      })),
      status: 'pending_approval',
      createdBy: req.user.id,
      createdAt: new Date(),
      notes: notes?.trim(),
    });
    await newReturn.save({ session });

    // Update order with return reference
    order.returns = order.returns || [];
    order.returns.push(newReturn._id);
    await order.save({ session });

    // Deduct from inventory temporarily for pending return
    for (const item of items) {
      const inventoryItem = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Insufficient stock for return:`, {
          productId: item.product,
          branchId,
          currentStock: inventoryItem?.currentStock || 0,
          requested: item.quantity,
          userId: req.user.id,
        });
        return res.status(400).json({ success: false, message: `الكمية غير كافية في المخزون للمنتج ${item.product}` });
      }
      inventoryItem.currentStock -= item.quantity;
      inventoryItem.movements.push({
        type: 'out',
        quantity: item.quantity,
        reference: `طلب إرجاع قيد الانتظار #${returnNumber}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
      await inventoryItem.save({ session });

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: branchId,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `طلب إرجاع قيد الانتظار #${returnNumber}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
      await historyEntry.save({ session });
    }

    // Populate return data
    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // Notify users
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: branchId },
      ],
    }).select('_id role').lean();
    const eventId = `${newReturn._id}-returnCreated`;
    await notifyUsers(
      io,
      usersToNotify,
      'returnCreated',
      `تم إنشاء طلب إرجاع جديد #${returnNumber}`,
      {
        returnId: newReturn._id,
        returnNumber,
        orderId,
        orderNumber: order.orderNumber,
        branchId,
        branchName: populatedReturn.branch?.name || 'غير معروف',
        eventId,
      },
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'returnCreated', {
      returnId: newReturn._id,
      returnNumber,
      orderId,
      orderNumber: order.orderNumber,
      status: 'pending_approval',
      branchId,
      branchName: populatedReturn.branch?.name || 'غير معروف',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      eventId,
    });

    await session.commitTransaction();
    res.status(201).json({
      ...populatedReturn,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes, items } = req.body;

    // Validation
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid return status: ${status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (!items || !Array.isArray(items)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid items array:`, { items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'مصفوفة العناصر مطلوبة' });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized return approval:`, {
        userId: req.user.id,
        role: req.user.role,
      });
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع' });
    }

    // Fetch return and order
    const returnRequest = await Return.findById(id).populate('order items.product').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Return not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }
    const order = await Order.findById(returnRequest.order._id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for return: ${returnRequest.order._id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    // Validate items
    if (items.length !== returnRequest.items.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Mismatch in items array length:`, {
        provided: items.length,
        expected: returnRequest.items.length,
        userId: req.user.id,
      });
      return res.status(400).json({ success: false, message: 'يجب توفير حالة لجميع العناصر' });
    }
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !['approved', 'rejected'].includes(item.status)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid item status:`, { item, userId: req.user.id });
        return res.status(400).json({ success: false, message: 'حالة العنصر أو معرفه غير صالح' });
      }
      const returnItem = returnRequest.items.find(i => i.itemId.toString() === item.itemId.toString());
      if (!returnItem) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Return item not found:`, { itemId: item.itemId, userId: req.user.id });
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في طلب الإرجاع` });
      }
    }

    // Update order and inventory
    let adjustedTotal = order.adjustedTotal;
    for (const returnItem of returnRequest.items) {
      const itemUpdate = items.find(i => i.itemId.toString() === returnItem.itemId.toString());
      if (!itemUpdate) continue;
      const orderItem = order.items.id(returnItem.itemId);
      if (!orderItem) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order item not found for return: ${returnItem.itemId}, User: ${req.user.id}`);
        return res.status(400).json({ success: false, message: `العنصر ${returnItem.itemId} غير موجود في الطلب` });
      }
      if (itemUpdate.status === 'approved') {
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        adjustedTotal -= returnItem.quantity * orderItem.price;
      } else if (itemUpdate.status === 'rejected') {
        // Add back to inventory if rejected
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: returnItem.quantity,
                reference: `رفض إرجاع #${returnRequest.returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );
        const historyEntry = new InventoryHistory({
          product: returnItem.product,
          branch: returnRequest.branch,
          action: 'return_rejected',
          quantity: returnItem.quantity,
          reference: `رفض إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
          createdAt: new Date(),
        });
        await historyEntry.save({ session });
      }
      returnItem.status = itemUpdate.status;
      returnItem.reviewNotes = itemUpdate.reviewNotes?.trim();
    }

    // Update order
    order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;
    order.markModified('items');
    await order.save({ session });

    // Update return status
    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    returnRequest.statusHistory = returnRequest.statusHistory || [];
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: reviewNotes,
      changedAt: new Date(),
    });
    await returnRequest.save({ session });

    // Populate data
    const populatedOrder = await Order.findById(returnRequest.order._id)
      .populate('branch', 'name')
      .populate({ path: 'items.product', select: 'name price unit department', populate: { path: 'department', select: 'name code' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();
    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .session(session)
      .lean();

    // Notify users
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.branch },
      ],
    }).select('_id role').lean();
    const eventId = `${id}-returnStatusUpdated`;
    await notifyUsers(
      io,
      usersToNotify,
      'returnStatusUpdated',
      `تم تحديث حالة الإرجاع #${returnRequest.returnNumber} إلى ${status}`,
      {
        returnId: id,
        returnNumber: returnRequest.returnNumber,
        orderId: returnRequest.order._id,
        orderNumber: returnRequest.order.orderNumber,
        branchId: returnRequest.branch,
        status,
        eventId,
      },
      true
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.branch}`], 'returnStatusUpdated', {
      returnId: id,
      returnNumber: returnRequest.returnNumber,
      orderId: returnRequest.order._id,
      orderNumber: returnRequest.order.orderNumber,
      status,
      reviewNotes,
      branchId: returnRequest.branch,
      branchName: populatedReturn.branch?.name || 'غير معروف',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: populatedOrder.adjustedTotal,
      eventId,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedReturn,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: populatedOrder.adjustedTotal,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all returns
const getReturns = async (req, res) => {
  try {
    const { status, branch, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.error(`[${new Date().toISOString()}] Invalid branch ID for user:`, {
          userId: req.user.id,
          branchId: req.user.branchId,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }
    const returns = await Return.find(query)
      .populate('order', 'orderNumber totalAmount')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();
    const total = await Return.countDocuments(query);
    console.log(`[${new Date().toISOString()}] Fetched returns:`, {
      count: returns.length,
      userId: req.user.id,
      query,
    });
    res.status(200).json({
      returns: returns.map(r => ({
        ...r,
        createdAt: new Date(r.createdAt).toISOString(),
        reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
      })),
      total,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching returns:`, { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = { createReturn, approveReturn, getReturns };