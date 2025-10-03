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
  const uniqueRooms = new Set(rooms);
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
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
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }
};

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { orderId, items, reason, notes } = req.body;

    if (!isValidObjectId(orderId) || !items?.length || !reason) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId, items or reason:`, { orderId, items, reason, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الطلب والعناصر والسبب مطلوبة' });
    }

    const order = await Order.findById(orderId).populate('items.product').populate('branch').session(session);
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

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    if (new Date(order.deliveredAt || order.createdAt) < threeDaysAgo) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' });
    }

    if (!['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(reason)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'سبب الإرجاع غير صالح' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.product) || !item.quantity || !['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(item.reason)) {
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

      const inventoryItem = await Inventory.findOne({ product: item.product, branch: order.branch }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.product}` });
      }
    }

    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

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
              order: orderId,
            },
          },
        },
        { new: true, session }
      );

      if (!inventoryUpdate) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `المخزون غير موجود للمنتج ${item.product}` });
      }

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: order.branch,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `طلب إرجاع قيد الانتظار #${returnNumber}`,
        createdBy: req.user.id,
        order: orderId,
      });
      await historyEntry.save({ session });
    }

    const newReturn = new Return({
      returnNumber,
      order: orderId,
      branch: order.branch,
      items: items.map(item => ({
        itemId: item.itemId,
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      reason,
      status: 'pending_approval',
      createdBy: req.user.id,
      notes: notes?.trim(),
    });
    await newReturn.save({ session });

    for (const item of items) {
      const orderItem = order.items.find(i => i._id.toString() === item.itemId.toString());
      if (orderItem) {
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
        orderItem.returnReason = item.reason;
        order.markModified('items');
      }
    }

    order.returns.push(newReturn._id);
    order.adjustedTotal = order.items.reduce((sum, item) => {
      const returnedQty = item.returnedQuantity || 0;
      return sum + (item.quantity - returnedQty) * item.price;
    }, 0);
    await order.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
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
      'return_status_updated',
      'notifications.return_status_updated',
      {
        returnId: newReturn._id,
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${newReturn._id}-return_status_updated`,
      }
    );

    const returnData = {
      returnId: newReturn._id,
      orderId,
      status: 'pending_approval',
      branchId: order.branch,
      branchName: populatedReturn.order?.branch?.name || populatedReturn.branch?.name || 'Unknown',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      eventId: `${newReturn._id}-return_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnStatusUpdated', returnData);

    await session.commitTransaction();
    res.status(201).json({ success: true, returnRequest: populatedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });
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

    let adjustedTotal = order.adjustedTotal || order.totalAmount;

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

        const historyEntry = new InventoryHistory({
          product: returnItem.product,
          branch: returnRequest.order.branch,
          action: 'return_approved',
          quantity: -returnItem.quantity,
          reference: `معالجة إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
          order: returnRequest.order._id,
        });
        await historyEntry.save({ session });
      }

      order.adjustedTotal = order.items.reduce((sum, item) => {
        const returnedQty = item.returnedQuantity || 0;
        return sum + (item.quantity - returnedQty) * item.price;
      }, 0);
      order.markModified('items');
      await order.save({ session });
    } else if (status === 'rejected') {
      for (const returnItem of returnRequest.items) {
        const inventoryUpdate = await Inventory.findOneAndUpdate(
          { branch: returnRequest.order.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: returnItem.quantity,
                reference: `رفض إرجاع #${returnRequest.returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
                order: returnRequest.order._id,
              },
            },
          },
          { new: true, session }
        );

        const historyEntry = new InventoryHistory({
          product: returnItem.product,
          branch: returnRequest.order.branch,
          action: 'return_rejected',
          quantity: returnItem.quantity,
          reference: `رفض إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
          order: returnRequest.order._id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: returnRequest.order.branch.toString(),
          productId: returnItem.product.toString(),
          quantity: inventoryUpdate.currentStock,
          type: 'return_rejected',
          orderId: returnRequest.order._id,
        });
      }
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: reviewNotes,
      changedAt: new Date(),
    });
    await returnRequest.save({ session });

    const populatedOrder = await Order.findById(returnRequest.order._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('items.assignedTo', 'username')
      .populate('createdBy', 'username')
      .populate('returns')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.order.branch },
      ],
    }).select('_id role').lean();

    await notifyUsers(
      io,
      usersToNotify,
      'return_status_updated',
      'notifications.return_status_updated',
      {
        returnId: id,
        orderId: returnRequest.order._id,
        orderNumber: returnRequest.order.orderNumber,
        branchId: returnRequest.order.branch,
        eventId: `${id}-return_status_updated`,
      }
    );

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .lean();

    const returnData = {
      returnId: id,
      orderId: returnRequest.order._id,
      status,
      reviewNotes,
      branchId: returnRequest.order.branch,
      branchName: populatedReturn.order?.branch?.name || populatedReturn.branch?.name || 'Unknown',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: populatedOrder.adjustedTotal,
      eventId: `${id}-return_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.order.branch}`], 'returnStatusUpdated', returnData);

    await session.commitTransaction();
    res.status(200).json({ success: true, returnRequest: { ...populatedReturn, adjustedTotal: populatedOrder.adjustedTotal } });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };