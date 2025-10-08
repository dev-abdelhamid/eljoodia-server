const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
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

    const { branchId, items, reason, notes, orders = [] } = req.body;

    if (!isValidObjectId(branchId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع والعناصر مطلوبة' });
    }

    let linkedOrders = orders.filter(isValidObjectId);

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branch._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول للهذا الفرع' });
    }

    const productIds = items.map(i => i.product);
    const possibleOrders = await Order.find({
      branch: branchId,
      status: 'delivered',
      'items.product': { $in: productIds },
    }).select('_id').session(session);
    linkedOrders = [...new Set([...linkedOrders, ...possibleOrders.map(o => o._id)])];

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

      item.price = product.price;

      const inventoryItem = await Inventory.findOne({ product: item.product, branch: branch._id }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.product}` });
      }

      inventoryItem.currentStock -= item.quantity;
      await inventoryItem.save({ session });

      const history = new InventoryHistory({
        product: item.product,
        branch: branch._id,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `طلب إرجاع قيد الانتظار`,
        referenceType: 'return',
        referenceId: new mongoose.Types.ObjectId(), // Temporary, update later
        createdBy: req.user.id,
        notes: item.reason,
      });
      await history.save({ session });
    }

    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0,10)}-${returnCount + 1}`;

    const newReturn = new Return({
      returnNumber,
      orders: linkedOrders,
      branch: branch._id,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        price: item.price,
        reason: item.reason,
      })),
      reason,
      status: 'pending_approval',
      createdBy: req.user.id,
      notes,
    });
    await newReturn.save({ session });

    // Update history referenceId
    await InventoryHistory.updateMany(
      { referenceId: new mongoose.Types.ObjectId() }, // Temporary ID
      { referenceId: newReturn._id }
    );

    for (const ordId of linkedOrders) {
      const ord = await Order.findById(ordId).session(session);
      if (ord) {
        ord.returns.push(newReturn._id);
        await ord.save({ session });
      }
    }

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('orders', 'orderNumber')
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
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
        branchId: branch._id,
        eventId: `${newReturn._id}-return_status_updated`,
      }
    );

    const returnData = {
      returnId: newReturn._id,
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
        const inventoryItem = await Inventory.findOne({ product: returnItem.product, branch: returnRequest.branch }).session(session);
        if (inventoryItem) {
          inventoryItem.currentStock -= returnItem.quantity; // Final deduction if not already done
          await inventoryItem.save({ session });
        }

        const history = new InventoryHistory({
          product: returnItem.product,
          branch: returnRequest.branch,
          action: 'return_approved',
          quantity: -returnItem.quantity,
          reference: `إرجاع موافق عليه #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          notes: returnItem.reason,
        });
        await history.save({ session });
      }
    } else if (status === 'rejected') {
      returnRequest.damaged = true;
      for (const returnItem of returnRequest.items) {
        const inventoryItem = await Inventory.findOne({ product: returnItem.product, branch: returnRequest.branch }).session(session);
        if (inventoryItem) {
          inventoryItem.damagedStock += returnItem.quantity;
          await inventoryItem.save({ session });
        }

        const history = new InventoryHistory({
          product: returnItem.product,
          branch: returnRequest.branch,
          action: 'return_rejected',
          quantity: returnItem.quantity,
          reference: `رفض إرجاع #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          notes: returnItem.reason,
        });
        await history.save({ session });
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
      .populate('orders', 'orderNumber')
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' }
      })
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
        branchId: returnRequest.branch,
        eventId: `${id}-return_status_updated`,
      }
    );

    const returnData = {
      returnId: id,
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