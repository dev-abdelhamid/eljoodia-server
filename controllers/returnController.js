const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { createNotification } = require('../utils/notifications');
const { emitSocketEvent } = require('../utils/socket');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderId, branchId, reason, items, notes } = req.body;

    if (!isValidObjectId(orderId) || !isValidObjectId(branchId) || !items?.length || !reason) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب، الفرع، السبب، والعناصر مطلوبة' : 'Order ID, branch ID, reason, and items are required' });
    }

    const order = await Order.findById(orderId).populate('items.product').session(session);
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
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "تم التسليم"' : 'Order must be in "delivered" status' });
    }

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    if (new Date(order.createdAt) < threeDaysAgo) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' : 'Cannot create return for order older than 3 days' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || !item.reason) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data' });
      }
      const orderItem = order.items.find(i => i.product._id.toString() === item.product.toString());
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `المنتج ${item.product} غير موجود في الطلب` : `Product ${item.product} not found in order` });
      }
      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للمنتج ${item.product}` : `Return quantity exceeds available quantity for product ${item.product}` });
      }
    }

    for (const item of items) {
      const inventoryUpdate = await Inventory.findOneAndUpdate(
        { branch: order.branch, product: item.product },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'out',
              quantity: item.quantity,
              reference: isRtl ? 'طلب إرجاع قيد الانتظار' : 'Pending return request',
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { new: true, session }
      );
      if (!inventoryUpdate) {
        throw new Error(isRtl ? `المخزون غير موجود للمنتج ${item.product}` : `Inventory not found for product ${item.product}`);
      }
      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: order.branch,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: isRtl ? 'طلب إرجاع قيد الانتظار' : 'Pending return request',
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    const returnCount = await Return.countDocuments().session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

    const newReturn = new Return({
      returnNumber,
      order: orderId,
      branch: branchId,
      reason,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      status: 'pending',
      createdBy: req.user.id,
      notes: notes?.trim(),
    });

    await newReturn.save({ session });
    order.returns.push(newReturn._id);
    await order.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch')
      .populate('items.product', 'name')
      .populate('createdBy', 'username')
      .populate('branch', 'name')
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

    await createNotification(
      usersToNotify.map(u => u._id),
      'return_created',
      isRtl ? 'notifications.return_created' : 'notifications.return_created_en',
      { returnId: newReturn._id, orderId, orderNumber: order.orderNumber, branchId: order.branch },
      io
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'returnCreated', {
      returnId: newReturn._id,
      orderId,
      returnNumber,
      status: 'pending',
      branchId: order.branch,
      branchName: populatedReturn.branch?.name || (isRtl ? 'فرع غير معروف' : 'Unknown branch'),
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      displayReason: populatedReturn.displayReason,
    });

    await session.commitTransaction();
    res.status(201).json({
      ...populatedReturn,
      displayReason: populatedReturn.displayReason,
      items: populatedReturn.items.map(item => ({
        ...item,
        displayReason: item.displayReason,
      })),
      isRtl,
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
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة غير صالحة' : 'Invalid status' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Unauthorized to approve return' });
    }

    const returnRequest = await Return.findById(id)
      .populate('order')
      .populate('items.product')
      .setOptions({ context: { isRtl } })
      .session(session);

    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
    }

    const order = await Order.findById(returnRequest.order._id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    let adjustedTotal = order.adjustedTotal || order.totalAmount;
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.find(i => i.product.toString() === returnItem.product.toString());
        if (!orderItem) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: isRtl ? `العنصر ${returnItem.product} غير موجود في الطلب` : `Item ${returnItem.product} not found in order` });
        }
        if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${returnItem.product}` : `Return quantity exceeds available quantity for item ${returnItem.product}` });
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
          { branch: returnRequest.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: returnItem.quantity,
                reference: isRtl ? `رفض إرجاع #${returnRequest.returnNumber}` : `Rejected return #${returnRequest.returnNumber}`,
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
          reference: isRtl ? `رفض إرجاع #${returnRequest.returnNumber}` : `Rejected return #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
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
      .populate('order', 'orderNumber branch totalAmount adjustedTotal')
      .populate('items.product', 'name price')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .populate('branch', 'name')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.branch },
      ],
    }).select('_id role').lean();

    await createNotification(
      usersToNotify.map(u => u._id),
      'return_status_updated',
      isRtl ? 'notifications.return_status_updated' : 'notifications.return_status_updated_en',
      { returnId: id, orderId: returnRequest.order._id, orderNumber: returnRequest.order.orderNumber, branchId: returnRequest.branch },
      io
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.branch}`], 'returnStatusUpdated', {
      returnId: id,
      orderId: returnRequest.order._id,
      status,
      reviewNotes,
      branchId: returnRequest.branch,
      branchName: populatedReturn.branch?.name || (isRtl ? 'فرع غير معروف' : 'Unknown branch'),
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: order.adjustedTotal,
      displayReason: populatedReturn.displayReason,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedReturn,
      displayReason: populatedReturn.displayReason,
      items: populatedReturn.items.map(item => ({
        ...item,
        displayReason: item.displayReason,
      })),
      isRtl,
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