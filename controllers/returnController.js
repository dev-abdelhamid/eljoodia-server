const mongoose = require('mongoose');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع طلبات الإرجاع
const getAllReturns = async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] User accessing /api/returns:`, req.user);
    const { status, branch, page = 1, limit = 10 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const returns = await Return.find(query)
      .populate('order', 'orderNumber totalAmount')
      .populate('branch', 'name')
      .populate('items.product', 'name price')
      .populate('createdBy', 'username')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    const total = await Return.countDocuments(query);
    res.status(200).json({ success: true, returns, total });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching returns:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// إنشاء طلب إرجاع
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { orderId, branchId, reason, items, notes } = req.body;

    // التحقق من صحة البيانات
    if (!isValidObjectId(orderId) || !isValidObjectId(branchId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو الفرع غير صالح' });
    }
    if (!reason || !items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'السبب أو العناصر غير صالحة' });
    }

    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب مسلمًا لإنشاء إرجاع' });
    }
    if (order.branch.toString() !== branchId || (req.user.role === 'branch' && branchId !== req.user.branchId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء إرجاع لهذا الطلب' });
    }

    // التحقق من أن الطلب لا يزيد عمره عن 3 أيام
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    if (new Date(order.createdAt) < threeDaysAgo) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' });
    }

    // التحقق من العناصر
    for (const item of items) {
      if (!isValidObjectId(item.product) || item.quantity < 1 || !item.reason) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }
      const orderItem = order.items.find((i) => i.product._id.toString() === item.product);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `المنتج ${item.product} غير موجود في الطلب` });
      }
      if (item.quantity > orderItem.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `كمية الإرجاع للمنتج ${item.product} تتجاوز الكمية المطلوبة` });
      }
    }

    // إنشاء رقم الإرجاع
    const returnCount = await Return.countDocuments().session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

    // إنشاء طلب الإرجاع
    const newReturn = new Return({
      returnNumber,
      order: orderId,
      branch: branchId,
      reason,
      items: items.map((item) => ({
        itemId: new mongoose.Types.ObjectId(),
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
        status: 'pending',
      })),
      status: 'pending',
      createdBy: req.user.id,
      notes: notes?.trim(),
    });

    await newReturn.save({ session });

    // تحديث الطلب
    order.returns = order.returns || [];
    order.returns.push({
      _id: newReturn._id,
      returnNumber,
      status: 'pending',
      items: items.map((item) => ({
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      reason,
      createdAt: new Date(),
    });
    await order.save({ session });

    await session.commitTransaction();

    // ملء البيانات
    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber totalAmount branch')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .lean();

    // إرسال حدث Socket.IO
    req.io?.emit('returnCreated', {
      returnId: newReturn._id,
      branchId,
      orderId,
      returnNumber,
      status: 'pending',
      reason,
      returnItems: items,
      createdAt: newReturn.createdAt,
    });

    res.status(201).json({ success: true, data: populatedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// تحديث حالة طلب الإرجاع
const updateReturnStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes, items } = req.body;

    // التحقق من صحة البيانات
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الإرجاع غير صالح' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب توفير حالة لجميع العناصر' });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حالة الإرجاع' });
    }

    // التحقق من اتساق حالة العناصر مع الحالة العامة
    const hasMixedStatuses = items.some((item) => item.status !== status);
    if (hasMixedStatuses) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة العناصر يجب أن تتطابق مع الحالة العامة للإرجاع' });
    }

    // تصحيح الخطأ الإملائي في حالة العنصر
    items.forEach((item) => {
      if (item.status === 'approve') {
        item.status = 'approved';
      }
    });

    const returnDoc = await Return.findById(id).populate('order items.product').session(session);
    if (!returnDoc) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الإرجاع غير موجود' });
    }

    const order = await Order.findById(returnDoc.order._id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    // التحقق من العناصر
    for (const item of items) {
      if (!isValidObjectId(item.itemId) || !isValidObjectId(item.productId) || !['approved', 'rejected'].includes(item.status)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }
      const returnItem = returnDoc.items.find((i) => i.itemId.toString() === item.itemId && i.product.toString() === item.productId);
      if (!returnItem) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير موجود في الإرجاع` });
      }
    }

    let returnTotal = 0;
    if (status === 'approved') {
      // حساب إجمالي المرتجع
      for (const returnItem of returnDoc.items) {
        const orderItem = order.items.find((item) => item.product.toString() === returnItem.product.toString());
        if (orderItem) {
          returnTotal += orderItem.price * returnItem.quantity;
        }
      }

      // تحديث إجمالي الطلب والملاحظات
      order.totalAmount -= returnTotal;
      if (order.totalAmount < 0) order.totalAmount = 0;
      const returnNote = `إرجاع مقبول (${returnDoc.returnNumber}) بقيمة ${returnTotal} ريال`;
      order.notes = order.notes ? `${order.notes}\n${returnNote}` : returnNote;
      order.returns = order.returns.map((r) =>
        r._id.toString() === id ? { ...r, status, reviewNotes } : r
      );
      await order.save({ session });

      // تحديث المخزون
      for (const item of items.filter((i) => i.status === 'approved')) {
        const returnItem = returnDoc.items.find((i) => i.itemId.toString() === item.itemId);
        if (returnItem) {
          await Inventory.findOneAndUpdate(
            { branch: returnDoc.branch, product: item.productId },
            {
              $inc: { currentStock: returnItem.quantity },
              $push: {
                movements: {
                  type: 'return_approved',
                  quantity: returnItem.quantity,
                  reference: returnDoc.returnNumber,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, upsert: true, session }
          );
        }
      }
    }

    // تحديث حالة العناصر في الإرجاع
    returnDoc.items = returnDoc.items.map((returnItem) => {
      const itemUpdate = items.find((i) => i.itemId === returnItem.itemId.toString());
      if (itemUpdate) {
        return {
          ...returnItem,
          status: itemUpdate.status,
          reviewNotes: itemUpdate.reviewNotes?.trim(),
        };
      }
      return returnItem;
    });

    // تحديث حالة الإرجاع
    returnDoc.status = status;
    returnDoc.reviewedBy = req.user.id;
    returnDoc.reviewedAt = new Date();
    returnDoc.reviewNotes = reviewNotes?.trim();
    returnDoc.statusHistory = returnDoc.statusHistory || [];
    returnDoc.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: reviewNotes,
      changedAt: new Date(),
    });
    await returnDoc.save({ session });

    await session.commitTransaction();

    // ملء البيانات
    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber totalAmount branch')
      .populate('items.product', 'name price')
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('reviewedBy', 'username')
      .lean();

    // إرسال حدث Socket.IO
    req.io?.emit('returnStatusUpdated', {
      returnId: id,
      orderId: returnDoc.order._id,
      branchId: returnDoc.branch,
      status,
      returnTotal: status === 'approved' ? returnTotal : 0,
      returnNote: status === 'approved' ? `إرجاع مقبول (${returnDoc.returnNumber})` : undefined,
    });

    res.status(200).json({ success: true, data: populatedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  getAllReturns,
  createReturn,
  updateReturnStatus,
};