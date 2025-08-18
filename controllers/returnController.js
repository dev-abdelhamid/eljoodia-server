const mongoose = require('mongoose');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

exports.processReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'معرف الإرجاع غير صالح' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'الحالة يجب أن تكون approved أو rejected' });
    }

    const returnDoc = await Return.findById(id).populate('order items.product');
    if (!returnDoc) {
      return res.status(404).json({ message: 'الإرجاع غير موجود' });
    }

    if (returnDoc.status !== 'pending') {
      return res.status(400).json({ message: 'الإرجاع ليس في حالة الانتظار' });
    }

    const order = await Order.findById(returnDoc.order._id);
    if (!order) {
      return res.status(404).json({ message: 'الطلب غير موجود' });
    }

    let returnTotal = 0;
    if (status === 'approved') {
      for (const returnItem of returnDoc.items) {
        const orderItem = order.items.find(
          (item) => item.product.toString() === returnItem.product.toString()
        );
        if (!orderItem) {
          return res.status(400).json({ message: `المنتج ${returnItem.product.name || returnItem.product} غير موجود في الطلب` });
        }
        const inventory = await Inventory.findOne({ branch: returnDoc.branch, product: returnItem.product });
        if (!inventory || inventory.currentStock < returnItem.quantity) {
          return res.status(400).json({ message: `المخزون غير كافٍ للمنتج ${returnItem.product.name || returnItem.product}` });
        }
        returnTotal += orderItem.price * returnItem.quantity;
        await Inventory.findOneAndUpdate(
          { branch: returnDoc.branch, product: returnItem.product },
          {
            $inc: { currentStock: -returnItem.quantity },
            $push: {
              movements: {
                type: 'return_approved',
                quantity: -returnItem.quantity,
                reference: returnDoc.returnNumber,
                createdBy: req.user._id,
                createdAt: new Date(),
              },
            },
          },
          { new: true }
        );
      }

      order.totalAmount -= returnTotal;
      if (order.totalAmount < 0) order.totalAmount = 0;
      const returnNote = `تمت الموافقة على المرتجع (${returnDoc.returnNumber}) بقيمة ${returnTotal} ريال`;
      order.notes = order.notes ? `${order.notes}\n${returnNote}` : returnNote;

      if (!Array.isArray(order.returns)) {
        order.returns = [];
      }

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
    }

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

    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber totalAmount branch')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['branch', 'admin'] }, branchId: returnDoc.order?.branch }).select('_id').lean();
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'return_status_updated',
        `تم ${status === 'approved' ? 'الموافقة' : 'الرفض'} على طلب الإرجاع للطلب ${returnDoc.order?.orderNumber || 'غير معروف'}`,
        { returnId: id, orderId: returnDoc.order?._id, orderNumber: returnDoc.order?.orderNumber },
        io
      );
    }

    io.to(returnDoc.order?.branch.toString()).emit('returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnDoc.order?.branch,
    });
    io.to('admin').emit('returnStatusUpdated', {
      returnId: id,
      status,
      returnNote: reviewNotes,
      branchId: returnDoc.order?.branch,
    });

    res.status(200).json(populatedReturn);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في معالجة المرتجع:`, err);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
};