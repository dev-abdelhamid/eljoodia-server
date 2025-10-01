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
    const isRtl = req.query.isRtl === 'true';
    const { orderId, items, notes, notesEn } = req.body;

    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب ومصفوفة العناصر مطلوبة' : 'Order ID and items array are required' });
    }

    const order = await Order.findById(orderId).populate('items.productId').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "تم التسليم" لإنشاء طلب إرجاع' : 'Order must be in "delivered" status to create a return' });
    }

    // Validate return items
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.productId) || !item.quantity || !['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(item.reason)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data' });
      }
      const orderItem = order.items.find(i => i._id.toString() === item.itemId.toString());
      if (!orderItem || orderItem.productId._id.toString() !== item.productId.toString()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `العنصر ${item.itemId} غير موجود أو لا يتطابق مع المنتج` : `Item ${item.itemId} not found or does not match the product` });
      }
      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${item.itemId}` : `Return quantity exceeds available quantity for item ${item.itemId}` });
      }
    }

    // Deduct from inventory
    for (const item of items) {
      const orderItem = order.items.find(i => i._id.toString() === item.itemId.toString());
      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.productId },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'out',
              quantity: item.quantity,
              reference: `طلب إرجاع قيد الانتظار`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { new: true, session }
      );
      if (!inventoryUpdate) {
        throw new Error(isRtl ? `المخزون غير موجود للمنتج ${item.productId}` : `Inventory not found for product ${item.productId}`);
      }
      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: order.branch,
        action: 'return',
        quantity: -item.quantity,
        reference: `طلب إرجاع قيد الانتظار`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    // Create return
    const returnCount = await Return.countDocuments().session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;
    const createdByUser = await User.findById(req.user.id).lean();

    const newReturn = new Return({
      returnNumber,
      order: orderId,
      branch: order.branch,
      items: items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        productNameEn: item.productNameEn,
        quantity: item.quantity,
        unit: item.unit,
        unitEn: item.unitEn,
        reason: item.reason,
        reasonEn: item.reasonEn,
        status: 'pending',
      })),
      status: 'pending',
      createdBy: req.user.id,
      createdAt: new Date(),
      notes: notes?.trim(),
      notesEn: notesEn?.trim() || notes?.trim(),
      statusHistory: [{
        status: 'pending',
        changedBy: req.user.id,
        changedByName: isRtl ? createdByUser.name : (createdByUser.nameEn || createdByUser.name),
        notes: notes?.trim(),
        notesEn: notesEn?.trim() || notes?.trim(),
        changedAt: new Date(),
      }],
    });

    await newReturn.save({ session });
    order.returns.push(newReturn._id);
    await order.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('items.productId', 'name nameEn unit unitEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean().session(session);

    await notifyUsers(
      io,
      usersToNotify,
      'returnCreated',
      isRtl ? `تم إنشاء طلب إرجاع رقم ${newReturn.returnNumber}` : `Return request ${newReturn.returnNumber} created`,
      {
        returnId: newReturn._id,
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        eventId: `${newReturn._id}-returnCreated`,
        isRtl,
      }
    );

    const returnData = {
      returnId: newReturn._id,
      returnNumber: newReturn.returnNumber,
      orderId,
      status: 'pending',
      branchId: order.branch,
      branchName: isRtl ? populatedReturn.order?.branch?.name : (populatedReturn.order?.branch?.nameEn || populatedReturn.order?.branch?.name || 'Unknown'),
      items: populatedReturn.items.map(item => ({
        ...item,
        productName: isRtl ? item.productName : (item.productNameEn || item.productName || 'Unknown'),
        unit: isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A'),
        displayReason: isRtl ? item.reason : item.reasonEn,
      })),
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      eventId: `${newReturn._id}-returnCreated`,
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnCreated', returnData);
    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: returnData,
      message: isRtl ? 'تم إنشاء طلب الإرجاع بنجاح' : 'Return request created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { status, reviewNotes, reviewNotesEn } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة غير صالحة' : 'Invalid return status' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Unauthorized to approve return' });
    }

    const returnRequest = await Return.findById(id).populate('order').populate('items.productId').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
    }

    const order = await Order.findById(returnRequest.order._id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    let adjustedTotal = order.adjustedTotal;
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.find(i => i._id.toString() === returnItem.itemId.toString());
        if (!orderItem) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: isRtl ? `العنصر ${returnItem.itemId} غير موجود في الطلب` : `Item ${returnItem.itemId} not found in order` });
        }
        if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${returnItem.itemId}` : `Return quantity exceeds available quantity for item ${returnItem.itemId}` });
        }
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        orderItem.returnReasonEn = returnItem.reasonEn;
        adjustedTotal -= returnItem.quantity * orderItem.price;
      }
      order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;
      order.markModified('items');
      await order.save({ session });
    } else if (status === 'rejected') {
      for (const returnItem of returnRequest.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.order?.branch, product: returnItem.productId },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: returnItem.quantity,
                reference: `رفض إرجاع #${returnRequest._id}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session }
        );
        const historyEntry = new InventoryHistory({
          product: returnItem.productId,
          branch: returnRequest.order?.branch,
          action: 'return_rejected',
          quantity: returnItem.quantity,
          reference: `رفض إرجاع #${returnRequest._id}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });
      }
    }

    const reviewedByUser = await User.findById(req.user.id).lean();
    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewNotesEn = reviewNotesEn?.trim() || reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedByName: isRtl ? reviewedByUser.name : (reviewedByUser.nameEn || reviewedByUser.name),
      notes: reviewNotes?.trim(),
      notesEn: reviewNotesEn?.trim() || reviewNotes?.trim(),
      changedAt: new Date(),
    });
    await returnRequest.save({ session });

    const populatedOrder = await Order.findById(returnRequest.order._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.productId', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.order?.branch },
      ],
    }).select('_id role').lean().session(session);

    await notifyUsers(
      io,
      usersToNotify,
      'returnStatusUpdated',
      isRtl ? `تم تحديث حالة طلب الإرجاع رقم ${returnRequest.returnNumber} إلى ${status}` : `Return request ${returnRequest.returnNumber} status updated to ${status}`,
      {
        returnId: id,
        orderId: returnRequest.order?._id,
        orderNumber: returnRequest.order?.orderNumber,
        branchId: returnRequest.order?.branch,
        eventId: `${id}-returnStatusUpdated`,
        isRtl,
      }
    );

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch')
      .populate('items.productId', 'name nameEn unit unitEn')
      .populate('createdBy', 'username name nameEn')
      .populate('reviewedBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const returnData = {
      returnId: id,
      returnNumber: populatedReturn.returnNumber,
      orderId: returnRequest.order?._id,
      status,
      reviewNotes,
      branchId: returnRequest.order?.branch,
      branchName: isRtl ? populatedReturn.order?.branch?.name : (populatedReturn.order?.branch?.nameEn || populatedReturn.order?.branch?.name || 'Unknown'),
      items: populatedReturn.items.map(item => ({
        ...item,
        productName: isRtl ? item.productName : (item.productNameEn || item.productName || 'Unknown'),
        unit: isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A'),
        displayReason: isRtl ? item.reason : item.reasonEn,
        displayReviewNotes: isRtl ? (item.reviewNotes || 'غير محدد') : (item.reviewNotesEn || item.reviewNotes || 'N/A'),
      })),
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: populatedOrder.adjustedTotal,
      eventId: `${id}-returnStatusUpdated`,
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.order?.branch}`], 'returnStatusUpdated', returnData);
    await session.commitTransaction();
    res.status(200).json({
      success: true,
      data: returnData,
      message: isRtl ? `تم تحديث حالة الإرجاع بنجاح` : 'Return status updated successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };