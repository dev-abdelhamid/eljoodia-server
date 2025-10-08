const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { updateInventoryStock } = require('../utils/inventoryUtils');
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

// Retry transaction helper
const retryTransaction = async (operation, maxRetries = 3) => {
  let retries = 0;
  while (retries < maxRetries) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await operation(session);
      await session.commitTransaction();
      return;
    } catch (err) {
      await session.abortTransaction();
      retries++;
      console.warn(`[${new Date().toISOString()}] Retrying transaction, attempt ${retries + 1}:`, err.message);
      if (retries === maxRetries) {
        throw new Error(`Failed after ${maxRetries} retries: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100 * retries));
    } finally {
      session.endSession();
    }
  }
};

const createReturn = async (req, res) => {
  try {
    await retryTransaction(async (session) => {
      const { branchId, items, reason, notes, orders = [] } = req.body;

      // Validate inputs
      if (!isValidObjectId(branchId) || !items?.length) {
        return res.status(400).json({ success: false, message: 'معرف الفرع والعناصر مطلوبة' });
      }

      let linkedOrders = orders.filter(isValidObjectId);

      // Validate branch
      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
      }

      // Check user authorization
      if (req.user.role === 'branch' && branch._id.toString() !== req.user.branchId.toString()) {
        return res.status(403).json({ success: false, message: 'غير مخول للهذا الفرع' });
      }

      // Find related orders
      const productIds = items.map(i => i.product);
      const possibleOrders = await Order.find({
        branch: branchId,
        status: 'delivered',
        'items.product': { $in: productIds },
      }).select('_id').session(session);
      linkedOrders = [...new Set([...linkedOrders, ...possibleOrders.map(o => o._id)])];

      // Validate items and prepare movements
      const movementsByProduct = {};
      const historyEntries = [];
      for (const item of items) {
        if (!isValidObjectId(item.product) || !item.quantity || !['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(item.reason)) {
          return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
        }

        const product = await Product.findById(item.product).session(session);
        if (!product) {
          return res.status(404).json({ success: false, message: `المنتج ${item.product} غير موجود` });
        }

        item.price = product.price;

        // Aggregate movements for the same product
        if (!movementsByProduct[item.product]) {
          movementsByProduct[item.product] = [];
        }
        movementsByProduct[item.product].push({
          type: 'out',
          quantity: item.quantity,
          reference: `طلب إرجاع قيد الانتظار`,
          createdBy: req.user.id,
          createdAt: new Date(),
        });

        // Prepare history entry
        historyEntries.push({
          product: item.product,
          branch: branch._id,
          action: 'return_pending',
          quantity: -item.quantity,
          reference: `طلب إرجاع قيد الانتظار`,
          referenceType: 'return',
          referenceId: new mongoose.Types.ObjectId(), // Temporary ID
          createdBy: req.user.id,
          notes: item.reason,
        });
      }

      // Batch update inventory
      for (const [productId, movements] of Object.entries(movementsByProduct)) {
        const totalQuantity = movements.reduce((sum, m) => sum + m.quantity, 0);
        await Inventory.findOneAndUpdate(
          { branch: branch._id, product: productId },
          {
            $inc: { currentStock: -totalQuantity },
            $push: { movements: { $each: movements } },
            $setOnInsert: {
              product: productId,
              branch: branch._id,
              createdBy: req.user.id,
              minStockLevel: 0,
              maxStockLevel: 1000,
              damagedStock: 0,
            },
          },
          { upsert: true, new: true, session }
        );
      }

      // Save history entries
      await InventoryHistory.insertMany(historyEntries, { session });

      // Create return
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
        notes: notes || '',
      });
      await newReturn.save({ session });

      // Update history referenceId
      await InventoryHistory.updateMany(
        { referenceId: { $in: historyEntries.map(h => h.referenceId) } },
        { referenceId: newReturn._id },
        { session }
      );

      // Link orders
      for (const ordId of linkedOrders) {
        const ord = await Order.findById(ordId).session(session);
        if (ord) {
          ord.returns.push(newReturn._id);
          await ord.save({ session });
        }
      }

      // Populate return data
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

      // Move notifications outside transaction
      await session.commitTransaction();

      // Notify users
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

      res.status(201).json({ success: true, returnRequest: populatedReturn });
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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

        await updateInventoryStock({
          branch: returnRequest.branch,
          product: returnItem.product,
          quantity: -returnItem.quantity,
          type: 'return_approved',
          reference: `إرجاع موافق عليه #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          notes: returnItem.reason,
        });
      }
    } else if (status === 'rejected') {
      returnRequest.damaged = true;
      for (const returnItem of returnRequest.items) {
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: returnItem.product,
          quantity: returnItem.quantity,
          type: 'return_rejected',
          reference: `رفض إرجاع #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          isDamaged: true,
          notes: returnItem.reason,
        });
      }
    }

    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim() || '';
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: reviewNotes?.trim() || '',
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

    await session.commitTransaction();

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
      reviewNotes: reviewNotes?.trim() || '',
      branchId: returnRequest.branch,
      branchName: populatedReturn.branch?.name || 'Unknown',
      items: populatedReturn.items,
      createdAt: new Date(populatedReturn.createdAt).toISOString(),
      reviewedAt: populatedReturn.reviewedAt ? new Date(populatedReturn.reviewedAt).toISOString() : null,
      adjustedTotal: adjustedTotal,
      eventId: `${id}-return_status_updated`,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.branch}`], 'returnStatusUpdated', returnData);

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