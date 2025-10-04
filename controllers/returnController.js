const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Branch = require('../models/Branch');
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
  await Promise.all(users.map(async (user) => {
    try {
      await createNotification(user._id, type, messageKey, data, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }));
};

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { orderId, branchId, items, reason, notes } = req.body;

    if (!isValidObjectId(branchId) || !items?.length || !reason) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input:`, { branchId, items, reason, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع والعناصر والسبب مطلوبة' });
    }

    let order = null;
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid orderId: ${orderId}, User: ${req.user.id}`);
        return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
      }
      order = await Order.findById(orderId).populate('items.product').populate('branch').session(session);
      if (!order) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order not found: ${orderId}, User: ${req.user.id}`);
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid order status: ${order.status}, User: ${req.user.id}`);
        return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم"' });
      }
    }

    const branch = order ? order.branch : await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Branch not found: ${branchId}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branch._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, { userBranch: req.user.branchId, branch: branch._id, userId: req.user.id });
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (!['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(reason)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid reason: ${reason}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'سبب الإرجاع غير صالح' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || !['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(item.reason)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid item:`, { item, userId: req.user.id });
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }

      if (order) {
        const orderItem = order.items.find(i => i.product._id.toString() === item.product);
        if (!orderItem) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Order item not found:`, { product: item.product, userId: req.user.id });
          return res.status(400).json({ success: false, message: `المنتج ${item.product} غير موجود في الطلب` });
        }
        if (item.itemId && item.itemId !== orderItem._id.toString()) {
          await session.abortTransaction();
          console.error(`[${ new Date().toISOString()}] ItemId mismatch:`, { itemId: item.itemId, orderItemId: orderItem._id, userId: req.user.id });
          return res.status(400).json({ success: false, message: `معرف العنصر لا يتطابق للمنتج ${item.product}` });
        }
        if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Invalid return quantity:`, { product: item.product, requested: item.quantity, available: orderItem.quantity - (orderItem.returnedQuantity || 0), userId: req.user.id });
          return res.status(400).json({ success: false, message: `الكمية المطلوبة تتجاوز المتاحة للمنتج ${item.product}` });
        }
      }

      const inventoryItem = await Inventory.findOne({ product: item.product, branch: branch._id }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Insufficient stock:`, { product: item.product, currentStock: inventoryItem?.currentStock, requested: item.quantity, userId: req.user.id });
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.product}` });
      }
    }

    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

    for (const item of items) {
      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { branch: branch._id, product: item.product },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'out',
              quantity: item.quantity,
              reference: `طلب إرجاع قيد الانتظار #${returnNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
              order: orderId || null,
            },
          },
        },
        { new: true, session }
      );

      if (!inventoryUpdate) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Inventory not found:`, { product: item.product, branch: branch._id, userId: req.user.id });
        return res.status(400).json({ success: false, message: `المخزون غير موجود للمنتج ${item.product}` });
      }

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: branch._id,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `طلب إرجاع قيد الانتظار #${returnNumber}`,
        createdBy: req.user.id,
        order: orderId || null,
      });
      await historyEntry.save({ session });
    }

    const newReturn = new Return({
      returnNumber,
      order: orderId || null,
      branch: branch._id,
      items: items.map(item => ({
        itemId: order ? order.items.find(i => i.product._id.toString() === item.product)?._id : null,
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

    if (orderId) {
      order.returns.push(newReturn._id);
      await order.save({ session });
    }

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
        { role: 'branch', branch: branch._id },
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
        orderNumber: order ? order.orderNumber : 'No Order',
        branchId: branch._id,
        eventId: `${newReturn._id}-return_status_updated`,
      }
    );

    const returnData = {
      returnId: newReturn._id,
      orderId,
      status: 'pending_approval',
      branchId: branch._id,
      branchName: populatedReturn.branch?.name || 'Unknown',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      eventId: `${newReturn._id}-return_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch._id}`], 'returnStatusUpdated', returnData);

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
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized approval:`, { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع' });
    }

    let order = null;
    if (returnRequest.order) {
      order = await Order.findById(returnRequest.order._id).session(session);
      if (!order) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Order not found: ${returnRequest.order._id}, User: ${req.user.id}`);
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
    }

    let adjustedTotal = order ? (order.adjustedTotal || order.totalAmount) : 0;

    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const inventoryUpdate = await Inventory.findOneAndUpdate(
          { branch: returnRequest.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: returnItem.quantity,
                reference: `موافقة إرجاع #${returnRequest.returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
                order: returnRequest.order ? returnRequest.order._id : null,
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
          reference: `موافقة إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
          order: returnRequest.order ? returnRequest.order._id : null,
        });
        await historyEntry.save({ session });

        if (returnRequest.order) {
          const orderItem = order.items.find(i => i.product._id.toString() === returnItem.product._id.toString());
          if (orderItem) {
            orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
            orderItem.returnReason = returnItem.reason;
          }
        }
      }

      if (returnRequest.order) {
        order.adjustedTotal = order.items.reduce((sum, item) => {
          const returnedQty = item.returnedQuantity || 0;
          return sum + (item.quantity - returnedQty) * item.price;
        }, 0);
        order.markModified('items');
        await order.save({ session });
      }
    } else if (status === 'rejected') {
      for (const returnItem of returnRequest.items) {
        const inventoryUpdate = await Inventory.findOneAndUpdate(
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
                order: returnRequest.order ? returnRequest.order._id : null,
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
          order: returnRequest.order ? returnRequest.order._id : null,
        });
        await historyEntry.save({ session });
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

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.branch },
      ],
    }).select('_id role').lean();

    await notifyUsers(
      io,
      usersToNotify,
      'return_status_updated',
      'notifications.return_status_updated',
      {
        returnId: id,
        orderId: returnRequest.order ? returnRequest.order._id : null,
        orderNumber: returnRequest.order ? returnRequest.order.orderNumber : 'No Order',
        branchId: returnRequest.branch,
        eventId: `${id}-return_status_updated`,
      }
    );

    const returnData = {
      returnId: id,
      orderId: returnRequest.order ? returnRequest.order._id : null,
      status,
      reviewNotes,
      branchId: returnRequest.branch,
      branchName: populatedReturn.branch?.name || 'Unknown',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: order ? order.adjustedTotal : 0,
      eventId: `${id}-return_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.branch}`], 'returnStatusUpdated', returnData);

    await session.commitTransaction();
    res.status(200).json({ success: true, returnRequest: { ...populatedReturn, adjustedTotal: order ? order.adjustedTotal : 0 } });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };