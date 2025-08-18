// controllers/returnController.js
const Return = require('../models/Return');
const Inventory = require('../models/Inventory');
const Order = require('../models/Order');

exports.processReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    // Validate status
    if (!['approved', 'rejected', 'processed'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    // Find return
    const returnDoc = await Return.findById(id).populate('order items.product');
    if (!returnDoc) {
      return res.status(404).json({ message: 'Return not found' });
    }

    // Check if return is in pending status
    if (returnDoc.status !== 'pending') {
      return res.status(400).json({ message: 'Return is not in pending status' });
    }

    // Find associated order
    const order = await Order.findById(returnDoc.order._id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    let returnTotal = 0;
    if (status === 'approved') {
      // Calculate return total
      for (const returnItem of returnDoc.items) {
        const orderItem = order.items.find(
          (item) => item.product.toString() === returnItem.product.toString()
        );
        if (!orderItem) {
          return res.status(400).json({ message: `Product ${returnItem.product} not found in order` });
        }
        returnTotal += orderItem.price * returnItem.quantity;
      }

      // Update order total and notes
      order.totalAmount -= returnTotal;
      if (order.totalAmount < 0) order.totalAmount = 0;
      const returnNote = `Return approved (${returnDoc.returnNumber}) for ${returnTotal} SAR`;
      order.notes = order.notes ? `${order.notes}\n${returnNote}` : returnNote;

      // Initialize order.returns if undefined
      if (!Array.isArray(order.returns)) {
        order.returns = [];
      }

      // Update or add return in order.returns
      const returnIndex = order.returns.findIndex((r) => r._id.toString() === id);
      if (returnIndex >= 0) {
        order.returns[returnIndex] = {
          ...order.returns[returnIndex],
          status,
          reviewNotes: reviewNotes?.trim(),
        };
      } else {
        order.returns.push({
          _id: id,
          returnNumber: returnDoc.returnNumber,
          status,
          items: returnDoc.items.map((item) => ({
            product: item.product,
            quantity: item.quantity,
            reason: item.reason,
          })),
          reason: returnDoc.reason,
          createdAt: returnDoc.createdAt,
          reviewNotes: reviewNotes?.trim(),
        });
      }
      await order.save();

      // Update inventory
      for (const item of returnDoc.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnDoc.branch, product: item.product },
          {
            $inc: { currentStock: item.quantity }, // Increase stock for approved returns
            $push: {
              movements: {
                type: 'return_approved',
                quantity: item.quantity,
                reference: returnDoc.returnNumber,
                createdBy: req.user._id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, upsert: true }
        );
      }
    }

    // Update return document
    returnDoc.status = status;
    returnDoc.reviewedBy = req.user._id;
    returnDoc.reviewedAt = new Date();
    returnDoc.reviewNotes = reviewNotes?.trim();
    returnDoc.statusHistory = returnDoc.statusHistory || [];
    returnDoc.statusHistory.push({
      status,
      changedBy: req.user._id,
      notes: reviewNotes,
      changedAt: new Date(),
    });
    await returnDoc.save();

    // Populate return data
    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber totalAmount branch')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .lean();

    // Emit Socket.IO event
    req.io?.emit('returnStatusUpdated', {
      returnId: id,
      orderId: returnDoc.order._id,
      branchId: returnDoc.branch,
      status,
      returnTotal: status === 'approved' ? returnTotal : 0,
      returnNote: status === 'approved' ? `Return approved (${returnDoc.returnNumber})` : reviewNotes,
    });

    res.status(200).json(populatedReturn);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Process return error:`, err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};