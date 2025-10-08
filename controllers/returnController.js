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
    console.time('createReturnTransaction');
    await retryTransaction(async (session) => {
      const { branchId, items, notes, orders = [] } = req.body;

      // Validate inputs
      if (!isValidObjectId(branchId)) {
        return res.status(400).json({ success: false, message: 'Invalid branch ID', field: 'branchId', value: branchId });
      }
      if (!items?.length) {
        return res.status(400).json({ success: false, message: 'At least one item is required', field: 'items' });
      }

      let linkedOrders = orders.filter(isValidObjectId);

      // Validate branch
      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        return res.status(404).json({ success: false, message: 'Branch not found', field: 'branchId', value: branchId });
      }

      // Check user authorization
      if (req.user.role === 'branch' && branch._id.toString() !== req.user.branchId.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized for this branch', field: 'branchId', value: branchId });
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
      const reasonMap = {
        'تالف': 'Damaged',
        'منتج خاطئ': 'Wrong Item',
        'كمية زائدة': 'Excess Quantity',
        'أخرى': 'Other',
      };
      const movementsByProduct = {};
      const historyEntries = [];
      for (const item of items) {
        if (!isValidObjectId(item.product)) {
          return res.status(400).json({ success: false, message: 'Invalid product ID', field: 'items.product', value: item.product });
        }
        if (!item.quantity || item.quantity < 1) {
          return res.status(400).json({ success: false, message: 'Quantity must be a positive integer', field: 'items.quantity', value: item.quantity });
        }
        if (!['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'].includes(item.reason)) {
          return res.status(400).json({ success: false, message: 'Invalid item reason', field: 'items.reason', value: item.reason });
        }

        const product = await Product.findById(item.product).session(session);
        if (!product) {
          return res.status(404).json({ success: false, message: `Product not found`, field: 'items.product', value: item.product });
        }

        // Validate stock
        const inventory = await Inventory.findOne({ branch: branch._id, product: item.product }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          return res.status(422).json({ success: false, message: `Insufficient stock for product ${item.product}`, field: 'items.quantity', value: item.quantity });
        }

        item.price = product.price;
        item.reasonEn = item.reasonEn || reasonMap[item.reason] || 'Other';

        // Aggregate movements
        if (!movementsByProduct[item.product]) {
          movementsByProduct[item.product] = [];
        }
        movementsByProduct[item.product].push({
          type: 'out',
          quantity: item.quantity,
          reference: `Pending return request`,
          createdBy: req.user.id,
          createdAt: new Date(),
        });

        // Prepare history entry
        historyEntries.push({
          product: item.product,
          branch: branch._id,
          action: 'return_pending',
          quantity: -item.quantity,
          reference: `Pending return request`,
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
          reasonEn: item.reasonEn,
        })),
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
          select: 'name nameEn code',
        })
        .session(session)
        .lean();

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
    console.timeEnd('createReturnTransaction');
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating return:`, { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Server error', error: err.message, details: err.stack });
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
      return res.status(400).json({ success: false, message: 'Invalid return ID', field: 'returnId', value: id });
    }

    const returnRequest = await Return.findById(id).populate('items.product').session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Return not found', field: 'returnId', value: id });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid status', field: 'status', value: status });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized to approve return' });
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
          reference: `Approved return #${returnRequest.returnNumber}`,
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
          reference: `Rejected return #${returnRequest.returnNumber}`,
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
        select: 'name nameEn code',
      })
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
    console.error(`[${new Date().toISOString()}] Error approving return:`, { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Server error', error: err.message, details: err.stack });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };
