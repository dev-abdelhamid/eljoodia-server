const mongoose = require('mongoose');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/return-created.mp3',
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
    const { orderId, branchId, items, notes } = req.body;

    // التحقق من البيانات المدخلة
    if (!isValidObjectId(orderId) || !isValidObjectId(branchId) || !Array.isArray(items) || !items.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب، معرف الفرع، ومصفوفة العناصر مطلوبة' : 'Order ID, branch ID, and items array are required',
      });
    }

    const order = await Order.findById(orderId)
      .populate({
        path: 'items',
        populate: { path: 'product', select: 'name nameEn unit unitEn price' }
      })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch.toString() !== branchId) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch',
      });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'يجب أن يكون الطلب في حالة "تم التسليم" لإنشاء طلب إرجاع' : 'Order must be in "delivered" status to create a return',
      });
    }

    // التحقق من العناصر
    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || !['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(item.reason)) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data',
        });
      }
      const orderItem = order.items.find(i => i.itemId === item.itemId);
      if (!orderItem || orderItem.product._id.toString() !== item.product) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `العنصر ${item.itemId} غير موجود أو لا يتطابق مع المنتج` : `Item ${item.itemId} not found or does not match the product`,
        });
      }
      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${item.itemId}` : `Return quantity exceeds available quantity for item ${item.itemId}`,
        });
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
      items: items.map(item => {
        const orderItem = order.items.find(i => i.itemId === item.itemId);
        return {
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
          reasonEn: returnReasonMapping[item.reason] || item.reason,
          notes: item.notes?.trim(),
        };
      }),
      status: 'pending_approval',
      createdBy: req.user.id,
      notes: notes?.trim(),
      statusHistory: [{
        status: 'pending_approval',
        changedBy: req.user.id,
        notes: notes?.trim(),
        changedAt: new Date(),
      }],
    });

    await newReturn.save({ session });

    // تحديث كميات المرتجعات في الطلب
    for (const item of items) {
      const orderItem = order.items.find(i => i.itemId === item.itemId);
      if (orderItem) {
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
        orderItem.status = 'return_requested';
      }
    }
    order.returns = order.returns || [];
    order.returns.push({
      returnId: newReturn._id,
      items: items.map(item => ({
        productId: item.product,
        quantity: item.quantity,
        reason: item.reason,
        status: 'pending_approval',
      })),
      status: 'pending_approval',
      createdAt: new Date(),
    });
    await order.save({ session });

    // ملء البيانات
    const populatedReturn = await Return.findById(newReturn._id)
      .populate({
        path: 'order',
        select: 'orderNumber branch',
        populate: { path: 'branch', select: 'name nameEn' }
      })
      .populate('items.product', 'name nameEn unit unitEn price')
      .populate('createdBy', 'username name nameEn')
      .lean();

    const returnData = {
      _id: newReturn._id,
      returnId: newReturn._id,
      returnNumber: newReturn.returnNumber,
      orderId,
      branchId,
      branchName: isRtl ? populatedReturn.order.branch.name : (populatedReturn.order.branch.nameEn || populatedReturn.order.branch.name),
      items: populatedReturn.items.map(item => ({
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: item.quantity,
        reason: item.reason,
        reasonEn: item.reasonEn,
        notes: item.notes,
        unit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
        status: 'pending_approval',
      })),
      status: newReturn.status,
      notes: newReturn.notes,
      createdAt: new Date(newReturn.createdAt).toISOString(),
      eventId: `${newReturn._id}-returnCreated`,
    };

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: branchId },
      ],
    }).select('_id role').lean().session(session);

    await notifyUsers(
      io,
      usersToNotify,
      'returnCreated',
      isRtl ? `تم إنشاء طلب إرجاع رقم ${newReturn.returnNumber}` : `Return request ${newReturn.returnNumber} created`,
      returnData
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'returnCreated', returnData);
    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: returnData,
      message: isRtl ? 'تم إنشاء طلب الإرجاع بنجاح' : 'Return request created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

const processReturnItems = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { returnId, branchId, items, reviewNotes } = req.body;

    if (!isValidObjectId(returnId) || !isValidObjectId(branchId) || !Array.isArray(items) || !items.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الإرجاع، معرف الفرع، ومصفوفة العناصر مطلوبة' : 'Return ID, branch ID, and items array are required',
      });
    }

    const returnRequest = await Return.findById(returnId)
      .populate('items.product')
      .populate('order')
      .session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
    }

    if (returnRequest.branch.toString() !== branchId) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch',
      });
    }

    if (returnRequest.status !== 'pending_approval') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'الإرجاع تم معالجته بالفعل' : 'Return already processed',
      });
    }

    const order = await Order.findById(returnRequest.order._id)
      .populate({
        path: 'items',
        populate: { path: 'product', select: 'name nameEn unit unitEn price' }
      })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    let returnTotal = 0;
    for (const item of items) {
      const returnItem = returnRequest.items.find(ri => ri.product.toString() === item.productId);
      if (!returnItem || returnItem.quantity !== item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `بيانات العنصر غير صالحة للمنتج ${item.productId}` : `Invalid item data for product ${item.productId}`,
        });
      }
      const orderItem = order.items.find(oi => oi.product._id.toString() === item.productId);
      if (orderItem) {
        returnTotal += orderItem.price * item.quantity;
      }
    }

    // تحديث المخزون
    for (const item of items) {
      const inventoryItem = await Inventory.findOne({
        branch: branchId,
        product: item.productId,
      }).session(session);
      if (inventoryItem) {
        inventoryItem.currentStock += item.quantity;
        inventoryItem.movements.push({
          type: 'return_approved',
          quantity: item.quantity,
          reference: `إرجاع ${returnRequest.returnNumber}`,
          createdBy: req.user.id,
          createdAt: new Date(),
        });
        await inventoryItem.save({ session });
      } else {
        await Inventory.create({
          branch: branchId,
          product: item.productId,
          currentStock: item.quantity,
          minStockLevel: 0,
          maxStockLevel: 1000,
          movements: [{
            type: 'return_approved',
            quantity: item.quantity,
            reference: `إرجاع ${returnRequest.returnNumber}`,
            createdBy: req.user.id,
            createdAt: new Date(),
          }],
        }, { session });
      }
      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: branchId,
        action: 'return_approved',
        quantity: item.quantity,
        reference: `إرجاع ${returnRequest.returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    // تحديث حالة الإرجاع
    returnRequest.status = 'approved';
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    returnRequest.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      notes: reviewNotes?.trim(),
      changedAt: new Date(),
    });
    await returnRequest.save({ session });

    // تحديث الطلب
    order.totalAmount -= returnTotal;
    if (order.totalAmount < 0) order.totalAmount = 0;
    for (const item of items) {
      const orderItem = order.items.find(oi => oi.product._id.toString() === item.productId);
      if (orderItem) {
        orderItem.status = 'returned';
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
      }
    }
    order.returns = order.returns.map(r =>
      r.returnId.toString() === returnId ? { ...r, status: 'approved', reviewNotes } : r
    );
    await order.save({ session });

    // ملء البيانات
    const populatedReturn = await Return.findById(returnId)
      .populate({
        path: 'order',
        select: 'orderNumber branch totalAmount',
        populate: { path: 'branch', select: 'name nameEn' }
      })
      .populate('items.product', 'name nameEn unit unitEn price')
      .populate('createdBy', 'username name nameEn')
      .populate('reviewedBy', 'username name nameEn')
      .lean();

    const returnData = {
      returnId,
      returnNumber: populatedReturn.returnNumber,
      orderId: returnRequest.order._id,
      branchId,
      branchName: isRtl ? populatedReturn.order.branch.name : (populatedReturn.order.branch.nameEn || populatedReturn.order.branch.name),
      status: 'approved',
      reviewNotes,
      items: populatedReturn.items.map(item => ({
        productId: item.product._id,
        productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
        quantity: item.quantity,
        reason: item.reason,
        reasonEn: item.reasonEn,
        notes: item.notes,
        unit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
        status: 'approved',
      })),
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: new Date(populatedReturn.reviewedAt).toISOString(),
      adjustedTotal: order.totalAmount,
      eventId: `${returnId}-returnStatusUpdated`,
    };

    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: branchId },
      ],
    }).select('_id role').lean().session(session);

    await notifyUsers(
      io,
      usersToNotify,
      'returnStatusUpdated',
      isRtl ? `تم تحديث حالة طلب الإرجاع رقم ${populatedReturn.returnNumber} إلى مقبول` : `Return request ${populatedReturn.returnNumber} status updated to approved`,
      returnData
    );

    await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'returnStatusUpdated', returnData);
    await session.commitTransaction();
    res.status(200).json({
      success: true,
      data: returnData,
      message: isRtl ? 'تمت معالجة الإرجاع بنجاح' : 'Return processed successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error processing return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, processReturnItems };