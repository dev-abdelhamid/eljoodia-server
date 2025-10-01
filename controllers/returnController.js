const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const getDisplayName = (name, nameEn, isRtl) => {
  return isRtl ? (name || 'غير معروف') : (nameEn || name || 'Unknown');
};

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
    const { orderId, branchId, reason, items, notes } = req.body;

    // التحقق من صحة البيانات
    if (!isValidObjectId(orderId) || !isValidObjectId(branchId) || !reason || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'معرف الطلب، الفرع، السبب، والعناصر مطلوبة' : 'Order ID, branch ID, reason, and items are required' 
      });
    }

    // جلب الطلب
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false, 
        message: isRtl ? 'الطلب غير موجود' : 'Order not found' 
      });
    }

    // التحقق من صلاحيات الفرع
    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ 
        success: false, 
        message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' 
      });
    }

    // التحقق من حالة الطلب
    if (order.status !== 'delivered') {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'يجب أن يكون الطلب في حالة "تم التسليم"' : 'Order must be in "delivered" status' 
      });
    }

    // التحقق من مدة الطلب (3 أيام)
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    if (new Date(order.createdAt) < threeDaysAgo) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'لا يمكن إنشاء إرجاع لطلب أقدم من 3 أيام' : 'Cannot create return for order older than 3 days' 
      });
    }

    // التحقق من العناصر
    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || !item.reason) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data' 
        });
      }
      const orderItem = order.items.find(i => i.product._id.toString() === item.product.toString());
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? `المنتج ${item.product} غير موجود في الطلب` : `Product ${item.product} not found in order` 
        });
      }
      if (item.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false, 
          message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للمنتج ${item.product}` : `Return quantity exceeds available quantity for product ${item.product}` 
        });
      }
    }

    // خصم من المخزون
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

    // إنشاء رقم الإرجاع
    const returnCount = await Return.countDocuments().session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

    // إنشاء طلب الإرجاع
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

    // ملء البيانات
    const populatedReturn = await Return.findById(newReturn._id)
      .populate('order', 'orderNumber branch totalAmount adjustedTotal')
      .populate('branch', 'name nameEn')
      .populate('items.product', 'name nameEn price unit unitEn department')
      .populate({ path: 'items.product.department', select: 'name nameEn' })
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    // إرسال إشعارات
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();

    await notifyUsers(
      io,
      usersToNotify,
      'return_created',
      isRtl ? 'notifications.return_created_ar' : 'notifications.return_created_en',
      { 
        returnId: newReturn._id, 
        orderId, 
        orderNumber: order.orderNumber, 
        branchId: order.branch, 
        eventId: `${newReturn._id}-return_created` 
      }
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
      isRtl,
    });

    await session.commitTransaction();
    res.status(201).json({
      ...populatedReturn,
      displayReason: populatedReturn.displayReason,
      items: populatedReturn.items.map(item => ({
        ...item,
        displayReason: item.displayReason,
        product: {
          ...item.product,
          displayName: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
          displayUnit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
        },
      })),
      branch: {
        ...populatedReturn.branch,
        displayName: getDisplayName(populatedReturn.branch?.name, populatedReturn.branch?.nameEn, isRtl),
      },
      createdBy: {
        ...populatedReturn.createdBy,
        displayName: getDisplayName(populatedReturn.createdBy?.name, populatedReturn.createdBy?.nameEn, isRtl),
      },
      isRtl,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ 
      success: false, 
      message: isRtl ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
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

    // التحقق من صحة معرف الإرجاع
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' 
      });
    }

    // التحقق من الحالة
    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'حالة غير صالحة' : 'Invalid status' 
      });
    }

    // التحقق من الصلاحيات
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ 
        success: false, 
        message: isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Unauthorized to approve return' 
      });
    }

    // جلب طلب الإرجاع
    const returnRequest = await Return.findById(id)
      .populate('order')
      .populate('items.product')
      .setOptions({ context: { isRtl } })
      .session(session);

    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false, 
        message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' 
      });
    }

    // جلب الطلب المرتبط
    const order = await Order.findById(returnRequest.order._id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false, 
        message: isRtl ? 'الطلب غير موجود' : 'Order not found' 
      });
    }

    // تحديث إجمالي الطلب عند الموافقة
    let adjustedTotal = order.adjustedTotal || order.totalAmount;
    if (status === 'approved') {
      for (const returnItem of returnRequest.items) {
        const orderItem = order.items.find(i => i.product.toString() === returnItem.product.toString());
        if (!orderItem) {
          await session.abortTransaction();
          return res.status(400).json({ 
            success: false, 
            message: isRtl ? `العنصر ${returnItem.product} غير موجود في الطلب` : `Item ${returnItem.product} not found in order` 
          });
        }
        if (returnItem.quantity > (orderItem.quantity - (orderItem.returnedQuantity || 0))) {
          await session.abortTransaction();
          return res.status(400).json({ 
            success: false, 
            message: isRtl ? `الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للعنصر ${returnItem.product}` : `Return quantity exceeds available quantity for item ${returnItem.product}` 
          });
        }
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + returnItem.quantity;
        orderItem.returnReason = returnItem.reason;
        orderItem.returnReasonEn = returnItem.reasonEn;
        adjustedTotal -= returnItem.quantity * orderItem.price;
      }
      order.adjustedTotal = adjustedTotal > 0 ? adjustedTotal : 0;
      order.markModified('items');
      await order.save({ session });

      // تحديث المخزون عند الموافقة
      for (const returnItem of returnRequest.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnRequest.branch, product: returnItem.product },
          {
            $inc: { currentStock: returnItem.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: returnItem.quantity,
                reference: isRtl ? `إرجاع مقبول #${returnRequest.returnNumber}` : `Approved return #${returnRequest.returnNumber}`,
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
          action: 'return_approved',
          quantity: returnItem.quantity,
          reference: isRtl ? `إرجاع مقبول #${returnRequest.returnNumber}` : `Approved return #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });
      }
    } else if (status === 'rejected') {
      // إعادة الكمية إلى المخزون عند الرفض
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

    // تحديث حالة الإرجاع
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

    // ملء البيانات
    const populatedReturn = await Return.findById(id)
      .populate('order', 'orderNumber branch totalAmount adjustedTotal notes notesEn')
      .populate('branch', 'name nameEn')
      .populate('items.product', 'name nameEn price unit unitEn department')
      .populate({ path: 'items.product.department', select: 'name nameEn' })
      .populate('createdBy', 'username name nameEn')
      .populate('reviewedBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    // إرسال إشعارات
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
      isRtl ? 'notifications.return_status_updated_ar' : 'notifications.return_status_updated_en',
      { 
        returnId: id, 
        orderId: returnRequest.order._id, 
        orderNumber: returnRequest.order.orderNumber, 
        branchId: returnRequest.branch, 
        eventId: `${id}-return_status_updated` 
      }
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
      isRtl,
    });

    await session.commitTransaction();
    res.status(200).json({
      ...populatedReturn,
      displayReason: populatedReturn.displayReason,
      items: populatedReturn.items.map(item => ({
        ...item,
        displayReason: item.displayReason,
        product: {
          ...item.product,
          displayName: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
          displayUnit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
        },
      })),
      order: {
        ...populatedReturn.order,
        displayNotes: populatedReturn.order.displayNotes,
        branch: {
          ...populatedReturn.order.branch,
          displayName: getDisplayName(populatedReturn.order.branch?.name, populatedReturn.order.branch?.nameEn, isRtl),
        },
      },
      branch: {
        ...populatedReturn.branch,
        displayName: getDisplayName(populatedReturn.branch?.name, populatedReturn.branch?.nameEn, isRtl),
      },
      createdBy: {
        ...populatedReturn.createdBy,
        displayName: getDisplayName(populatedReturn.createdBy?.name, populatedReturn.createdBy?.nameEn, isRtl),
      },
      reviewedBy: populatedReturn.reviewedBy
        ? {
            ...populatedReturn.reviewedBy,
            displayName: getDisplayName(populatedReturn.reviewedBy.name, populatedReturn.reviewedBy.nameEn, isRtl),
          }
        : undefined,
      isRtl,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, userId: req.user.id });
    res.status(500).json({ 
      success: false, 
      message: isRtl ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
};

const getReturns = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, branch, page = 1, limit = 10, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    // بناء الاستعلام
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (req.user.role === 'branch') query.branch = req.user.branchId;
    if (search) {
      query.$or = [
        { returnNumber: { $regex: search, $options: 'i' } },
        { reason: { $regex: search, $options: 'i' } },
        { reasonEn: { $regex: search, $options: 'i' } },
      ];
    }

    // بناء الترتيب
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // جلب المرتجعات
    const returns = await Return.find(query)
      .populate('order', 'orderNumber totalAmount adjustedTotal branch notes notesEn')
      .populate('branch', 'name nameEn')
      .populate('items.product', 'name nameEn price unit unitEn department')
      .populate({ path: 'items.product.department', select: 'name nameEn' })
      .populate('createdBy', 'username name nameEn')
      .populate('reviewedBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .sort(sort)
      .lean();

    const total = await Return.countDocuments(query);

    res.status(200).json({
      returns: returns.map(ret => ({
        ...ret,
        displayReason: ret.displayReason,
        items: ret.items.map(item => ({
          ...item,
          displayReason: item.displayReason,
          product: {
            ...item.product,
            displayName: getDisplayName(item.product?.name, item.product?.nameEn, isRtl),
            displayUnit: getDisplayName(item.product?.unit, item.product?.unitEn, isRtl),
          },
        })),
        branch: {
          ...ret.branch,
          displayName: getDisplayName(ret.branch?.name, ret.branch?.nameEn, isRtl),
        },
        order: {
          ...ret.order,
          displayNotes: ret.order.displayNotes,
          branch: {
            ...ret.order.branch,
            displayName: getDisplayName(ret.order.branch?.name, ret.order.branch?.nameEn, isRtl),
          },
        },
        createdBy: {
          ...ret.createdBy,
          displayName: getDisplayName(ret.createdBy?.name, ret.createdBy?.nameEn, isRtl),
        },
        reviewedBy: ret.reviewedBy
          ? {
              ...ret.reviewedBy,
              displayName: getDisplayName(ret.reviewedBy.name, ret.reviewedBy.nameEn, isRtl),
            }
          : undefined,
        isRtl,
      })),
      total,
    });
  } catch (err) {
    console.error('Error fetching returns:', err);
    res.status(500).json({ 
      success: false, 
      message: req.query.isRtl === 'true' ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  }
};

module.exports = { createReturn, approveReturn, getReturns };