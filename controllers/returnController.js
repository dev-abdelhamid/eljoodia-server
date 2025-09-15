const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
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

const notifyUsers = async (io, users, type, messageKey, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, data, io);
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
    const { orderId, items, notes, branchId } = req.body;

    // Validation
    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId or items:`, { orderId, items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب ومصفوفة العناصر مطلوبة' });
    }
    if (!isValidObjectId(branchId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branchId:`, { branchId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    // Fetch order and validate
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }
    if (order.status !== 'delivered') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order status for return: ${order.status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم" لإنشاء طلب إرجاع' });
    }

    // Validate return items
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
        console.error(`[${new Date().toISOString()}] Invalid return quantity:`, {
          itemId: item.itemId,
          requested: item.quantity,
          available: orderItem.quantity - (orderItem.returnedQuantity || 0),
          userId: req.user.id,
        });
        return res.status(400).json({ success: false, message: `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${item.itemId}` });
      }
    }

    // Generate return number
    const returnCount = await Return.countDocuments().session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

    // Create return
    const newReturn = new Return({
      returnNumber,
      order: orderId,
      branch: order.branch,
      items: items.map(item => ({
        itemId: item.itemId,
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
        status: 'pending_approval',
      })),
      status: 'pending_approval',
      createdBy: req.user.id,
      createdAt: new Date().toISOString(),
      notes: notes?.trim(),
    });
    await newReturn.save({ session });

    // Update order with return reference
    order.returns = order.returns || [];
    order.returns.push(newReturn._id);
    await order.save({ session });

    // Deduct from inventory on creation
    for (const item of items) {
      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'out',
              quantity: item.quantity,
              reference: `طلب إرجاع قيد الانتظار #${returnNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { new: true, session }
      );
      if (!inventoryUpdate) {
        throw new Error(`المخزون غير موجود للمنتج ${item.product}`);
      }
      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: order.branch,
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

    // Notify users and emit socket event
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();
    const eventId = `${newReturn._id}-returnCreated`;
    await notifyUsers(
      io,
      usersToNotify,
      'return_created',
      'notifications.return_created',
      {
        returnId: newReturn._id,
        returnNumber,
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId,
      }
    );
    const returnData = {
      returnId: newReturn._id,
      returnNumber,
      orderId,
      orderNumber: order.orderNumber,
      status: 'pending_approval',
      branchId: order.branch,
      branchName: populatedReturn.branch?.name || 'غير معروف',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      eventId,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnCreated', returnData);

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
    if (!items || !Array.isArray(items) || items.length !== returnRequest.items.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid items array:`, { items, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'يجب توفير حالة لجميع العناصر' });
    }
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !['approved', 'rejected'].includes(item.status)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid item status:`, { item, userId: req.user.id });
        return res.status(400).json({ success: false, message: 'حالة العنصر غير صالحة' });
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
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const itemUpdate = items.find(i => i.itemId.toString() === returnItem.itemId.toString());
        if (!itemUpdate) continue;
        if (itemUpdate.status === 'approved') {
          const orderItem = order.items.id(returnItem.itemId);
          if (!orderItem) {
            await session.abortTransaction();
            console.error(`[${new Date().toISOString()}] Order item not found for return: ${returnItem.itemId}, User: ${req.user.id}`);
            return res.status(400).json({ success: false, message: `العنصر ${returnItem.itemId} غير موجود في الطلب` });
          }
          if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
            await session.abortTransaction();
            console.error(`[${new Date().toISOString()}] Invalid return quantity:`, {
              itemId: returnItem.itemId,
              requested: returnItem.quantity,
              available: orderItem.quantity - (orderItem.returnedQuantity || 0),
              userId: req.user.id,
            });
            return res.status(400).json({ success: false, message: `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${returnItem.itemId}` });
          }
          orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
          orderItem.returnReason = returnItem.reason;
          adjustedTotal -= returnItem.quantity * orderItem.price;

          // Update inventory for approved items
          await Inventory.findOneAndUpdate(
            { branch: returnRequest.branch, product: returnItem.product },
            {
              $inc: { currentStock: returnItem.quantity },
              $push: {
                movements: {
                  type: 'in',
                  quantity: returnItem.quantity,
                  reference: `إرجاع مقبول #${returnRequest.returnNumber}`,
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
            action: 'return_approved',
            quantity: returnItem.quantity,
            reference: `إرجاع مقبول #${returnRequest.returnNumber}`,
            createdBy: req.user.id,
            createdAt: new Date(),
          });
          await historyEntry.save({ session });
        }
        returnItem.status = itemUpdate.status;
        returnItem.reviewNotes = itemUpdate.reviewNotes?.trim();
      }
      order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;
      order.markModified('items');
      await order.save({ session });
    } else if (status === 'rejected') {
      for (const returnItem of returnRequest.items) {
        const itemUpdate = items.find(i => i.itemId.toString() === returnItem.itemId.toString());
        if (!itemUpdate) continue;
        if (itemUpdate.status === 'rejected') {
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
    }

    // Update return status
    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date().toISOString();
    returnRequest.statusHistory = returnRequest.statusHistory || [];
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: reviewNotes,
      changedAt: new Date(),
    });
    await returnRequest.save({ session });

    // Populate data for response
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

    // Notify users and emit socket event
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
      'return_status_updated',
      'notifications.return_status_updated',
      {
        returnId: id,
        returnNumber: returnRequest.returnNumber,
        orderId: returnRequest.order._id,
        orderNumber: returnRequest.order.orderNumber,
        branchId: returnRequest.branch,
        status,
        eventId,
      }
    );
    const returnData = {
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
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.branch}`], 'returnStatusUpdated', returnData);

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

module.exports = { createReturn, approveReturn };