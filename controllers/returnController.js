// controllers/returnController.js
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const InventoryHistory = require('../models/InventoryHistory');
const { createNotification } = require('../utils/notifications');
const { updateInventoryStock } = require('../utils/inventoryUtils');

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

    const { orderId, branchId, items, reason, notes, orders = [] } = req.body;

    if (!isValidObjectId(branchId) || !items?.length || !reason) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع والعناصر والسبب مطلوبة' });
    }

    let linkedOrders = orders.filter(isValidObjectId);
    let mainOrder = null;
    if (orderId && isValidObjectId(orderId)) {
      mainOrder = await Order.findById(orderId).populate('items.product').populate('branch').session(session);
      if (!mainOrder) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (mainOrder.status !== 'delivered') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم"' });
      }
      linkedOrders.push(orderId);
      linkedOrders = [...new Set(linkedOrders)];
    } else {
      // للمتابعة, ابحث عن طلبات محتملة
      const productIds = items.map(i => i.product);
      const possibleOrders = await Order.find({
        branch: branchId,
        status: 'delivered',
        'items.product': { $in: productIds },
      }).select('_id').session(session);
      linkedOrders = [...new Set([...linkedOrders, ...possibleOrders.map(o => o._id)])];
    }

    const branch = mainOrder ? mainOrder.branch : await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branch._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    if (!['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(reason)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'سبب الإرجاع غير صالح' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || !['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(item.reason)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }

      const product = await Product.findById(item.product).session(session);
      if (!product) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: `المنتج ${item.product} غير موجود` });
      }

      item.price = product.price; // default

      if (item.order) {
        if (!isValidObjectId(item.order)) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح للعنصر' });
        }

        const ord = await Order.findById(item.order).populate('items.product').session(session);
        if (!ord) {
          await session.abortTransaction();
          return res.status(404).json({ success: false, message: 'الطلب غير موجود للعنصر' });
        }

        const orderItem = ord.items.find(i => i.product.toString() === item.product);
        if (orderItem) {
          item.price = orderItem.price;
          item.itemId = orderItem._id;
          if (item.quantity > (orderItem.quantity - orderItem.returnedQuantity)) {
            await session.abortTransaction();
            return res.status(400).json({ success: false, message: `الكمية تتجاوز المتاحة للمنتج ${item.product} في الطلب ${item.order}` });
          }
        }
      }

      const inventoryItem = await Inventory.findOne({ product: item.product, branch: branch._id }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.product}` });
      }

      await updateInventoryStock({
        branch: branch._id,
        product: item.product,
        quantity: -item.quantity,
        type: 'return_pending',
        reference: `طلب إرجاع قيد الانتظار`,
        createdBy: req.user.id,
        session,
      });
    }

    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0,10)}-${returnCount + 1}`;

    const newReturn = new Return({
      returnNumber,
      order: orderId || null,
      orders: linkedOrders,
      branch: branch._id,
      items: items.map(item => ({
        order: item.order || null,
        itemId: item.itemId || null,
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        reason: item.reason,
        notes: item.notes,
      })),
      reason,
      status: 'pending_approval',
      createdBy: req.user.id,
      notes,
    });
    await newReturn.save({ session });

    for (const ordId of linkedOrders) {
      const ord = await Order.findById(ordId).session(session);
      if (ord) {
        ord.returns.push(newReturn._id);
        await ord.save({ session });
      }
    }

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('orders', 'orderNumber')
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
        orderNumber: mainOrder ? mainOrder.orderNumber : 'No Order',
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
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message });
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
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }

    const returnRequest = await Return.findById(id).populate('items.product').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة على الإرجاع' });
    }

    let adjustedTotal = 0;
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        // No additional inventory update, since already deducted in pending

        if (returnItem.order) {
          const ord = await Order.findById(returnItem.order).session(session);
          if (ord) {
            const orderItem = ord.items.find(i => i.product.toString() === returnItem.product.toString());
            if (orderItem) {
              orderItem.returnedQuantity += returnItem.quantity;
              orderItem.returnReason = returnItem.reason;
            }
            ord.adjustedTotal -= (returnItem.quantity * returnItem.price);
            await ord.save({ session });
            adjustedTotal += (returnItem.quantity * returnItem.price);
          }
        }
      }
    } else if (status === 'rejected') {
      returnRequest.damaged = true;
      for (const returnItem of returnRequest.items) {
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: returnItem.product._id,
          quantity: returnItem.quantity,
          type: 'return_rejected',
          reference: `رفض إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
          session,
          isDamaged: true,
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
      adjustedTotal: adjustedTotal,
      eventId: `${id}-return_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.branch}`], 'returnStatusUpdated', returnData);

    await session.commitTransaction();
    res.status(200).json({ success: true, returnRequest: { ...populatedReturn, adjustedTotal } });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };