const mongoose = require('mongoose');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

exports.processReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    // Validation
    if (!isValidObjectId(id)) {
      throw new Error('Invalid return ID');
    }
    if (!['approved', 'rejected'].includes(status)) {
      throw new Error('Invalid status');
    }
    if (!['production', 'admin'].includes(req.user.role)) {
      throw new Error('Unauthorized to process return');
    }

    // Fetch return and order
    const returnDoc = await Return.findById(id)
      .populate('order items.product')
      .session(session);
    if (!returnDoc) {
      throw new Error('Return not found');
    }
    if (returnDoc.status !== 'pending') {
      throw new Error('Return is not in pending status');
    }

    const order = await Order.findById(returnDoc.order._id).session(session);
    if (!order) {
      throw new Error('Order not found');
    }

    let returnTotal = 0;
    if (status === 'approved') {
      // Update inventory and order items
      for (const returnItem of returnDoc.items) {
        const orderItem = order.items.find(
          (item) => item.product.toString() === returnItem.product.toString()
        );
        if (!orderItem) {
          throw new Error(`Order item ${returnItem.product} not found`);
        }
        returnTotal += orderItem.price * returnItem.quantity;
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;

        await Inventory.findOneAndUpdate(
          { branch: returnDoc.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'return_approved',
                quantity: returnItem.quantity,
                reference: returnDoc.returnNumber,
                createdBy: req.user._id,
                createdAt: new Date(),
              },
            },
          },
          { upsert: true, new: true, session }
        );
      }

      // Update order total and notes
      order.totalAmount = Math.max(0, order.totalAmount - returnTotal);
      const returnNote = `Return approved (${returnDoc.returnNumber}) for ${returnTotal} SAR`;
      order.notes = order.notes ? `${order.notes}\n${returnNote}` : returnNote;
      order.returns = order.returns.map((r) =>
        r._id.toString() === id ? { ...r, status, reviewNotes: reviewNotes?.trim() } : r
      );
      order.markModified('items');
      await order.save({ session });
    }

    // Update return document
    returnDoc.status = status;
    returnDoc.reviewedBy = req.user._id;
    returnDoc.reviewedAt = new Date();
    returnDoc.reviewNotes = reviewNotes?.trim();
    returnDoc.statusHistory.push({
      status,
      changedBy: req.user._id,
      notes: reviewNotes?.trim(),
      changedAt: new Date(),
    });
    await returnDoc.save({ session });

    // Populate return data
    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber totalAmount branch')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .lean()
      .session(session);

    // Send notifications and socket events
    const io = req.app.get('io');
    const usersToNotify = await require('../models/User').find({
      role: { $in: ['branch', 'admin'] },
      branchId: returnDoc.order?.branch,
    }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `Return #${returnDoc.returnNumber} for order ${returnDoc.order?.orderNumber || 'Unknown'} has been ${status}`,
        { returnId: id, orderId: returnDoc.order?._id, orderNumber: returnDoc.order?.orderNumber },
        io
      );
    }

    const eventData = {
      returnId: id,
      orderId: returnDoc.order._id,
      branchId: returnDoc.branch,
      status,
      returnTotal: status === 'approved' ? returnTotal : 0,
      returnNote: reviewNotes?.trim() || `Return ${status} (${returnDoc.returnNumber})`,
      sound: status === 'approved' ? '/return-approved.mp3' : '/return-rejected.mp3',
      vibrate: [200, 100, 200],
    };
    io.to('admin').emit('returnStatusUpdated', eventData);
    io.to('production').emit('returnStatusUpdated', eventData);
    io.to(`branch-${returnDoc.order?.branch}`).emit('returnStatusUpdated', eventData);

    await session.commitTransaction();
    res.status(200).json(populatedReturn);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error processing return: ${err.message}`);
    res.status(400).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
};