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

const notifyUsers = async (io, users, type, messageKey, data, isRtl = true) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    data,
  });
  await Promise.all(users.map(async (user) => {
    try {
      await createNotification(user._id, type, messageKey, data, io, isRtl);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }));
};

const retryTransaction = async (operation, maxRetries = 5) => {
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
      await new Promise(resolve => setTimeout(resolve, 2000 * (retries + 1))); // Exponential backoff
    } finally {
      session.endSession();
    }
  }
};

const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    await retryTransaction(async (session) => {
      const { branchId, items, notes = '', orders = [] } = req.body;

      // Validate inputs
      if (!isValidObjectId(branchId)) {
        throw new Error(isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID');
      }
      if (!Array.isArray(items) || !items.length) {
        throw new Error(isRtl ? 'العناصر مطلوبة' : 'Items are required');
      }
      const validOrders = orders.filter(isValidObjectId);
      if (validOrders.length !== orders.length) {
        throw new Error(isRtl ? 'بعض معرفات الطلبات غير صالحة' : 'Some order IDs are invalid');
      }
      const reasonMap = {
        'تالف': 'Damaged',
        'منتج خاطئ': 'Wrong Item',
        'كمية زائدة': 'Excess Quantity',
        'أخرى': 'Other',
      };
      for (const item of items) {
        if (!isValidObjectId(item.product) || !item.quantity || item.quantity < 1 || !item.reason) {
          throw new Error(isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data');
        }
        if (!reasonMap[item.reason]) {
          throw new Error(isRtl ? 'سبب الإرجاع غير صالح' : 'Invalid return reason');
        }
        if (item.reasonEn && item.reasonEn !== reasonMap[item.reason]) {
          throw new Error(isRtl ? 'سبب الإرجاع بالإنجليزية غير متطابق' : 'English reason does not match Arabic reason');
        }
      }
      if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
        throw new Error(isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch');
      }

      // Validate branch
      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
      }

      // Find related orders
      const productIds = items.map(i => i.product);
      const possibleOrders = await Order.find({
        branch: branchId,
        status: 'delivered',
        'items.product': { $in: productIds },
      }).select('_id').session(session);
      const linkedOrders = [...new Set([...validOrders, ...possibleOrders.map(o => o._id)])];

      // Validate items and update inventory
      for (const item of items) {
        const product = await Product.findById(item.product).session(session);
        if (!product) {
          throw new Error(isRtl ? `المنتج ${item.product} غير موجود` : `Product ${item.product} not found`);
        }
        item.price = product.price;
        item.reasonEn = item.reasonEn || reasonMap[item.reason];

        const inventory = await Inventory.findOne({ branch: branch._id, product: item.product }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          throw new Error(isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient stock for product ${item.product}`);
        }

        // Move stock to pending
        await updateInventoryStock({
          branch: branch._id,
          product: item.product,
          quantity: -item.quantity,
          type: 'return_pending',
          reference: `Pending return`,
          referenceType: 'return',
          referenceId: new mongoose.Types.ObjectId(), // Temporary ID
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn})`,
          isPending: true,
          isRtl,
        });
      }

      // Create return
      const returnCount = await Return.countDocuments({ branch: branchId }).session(session);
      const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(returnCount + 1).toString().padStart(4, '0')}`;

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
        notes,
      });
      await newReturn.save({ session });

      // Update history referenceId
      await InventoryHistory.updateMany(
        { referenceId: { $in: items.map(i => i.referenceId) } },
        { referenceId: newReturn._id },
        { session }
      );

      // Link orders
      for (const ordId of linkedOrders) {
        const ord = await Order.findById(ordId).session(session);
        if (ord) {
          if (!ord.returns) ord.returns = [];
          if (!ord.returns.includes(newReturn._id)) ord.returns.push(newReturn._id);
          await ord.save({ session });
        }
      }

      // Populate return data
      const populatedReturn = await Return.findById(newReturn._id)
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('orders', 'orderNumber')
        .populate('createdBy', 'name nameEn username')
        .session(session)
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: {
          ...populatedReturn.branch,
          displayName: isRtl ? (populatedReturn.branch?.name || 'غير معروف') : (populatedReturn.branch?.nameEn || populatedReturn.branch?.name || 'Unknown'),
        },
        items: populatedReturn.items.map(item => ({
          ...item,
          product: {
            ...item.product,
            displayName: isRtl ? (item.product?.name || 'غير معروف') : (item.product?.nameEn || item.product?.name || 'Unknown'),
            displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
            department: item.product?.department ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
            } : null,
          },
          reasonDisplay: isRtl ? item.reason : item.reasonEn,
        })),
        createdByDisplay: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'Unknown'),
      };

      // Commit transaction
      await session.commitTransaction();

      // Notify users
      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id branch').lean();

      const branchName = populatedReturn.branch?.name || 'غير معروف';
      await notifyUsers(
        io,
        usersToNotify,
        'returnCreated',
        isRtl ? `طلب إرجاع جديد ${formattedReturn.returnNumber} من ${branchName}` : `New return request ${formattedReturn.returnNumber} from ${populatedReturn.branch?.nameEn || branchName}`,
        { returnId: newReturn._id, branchId, eventId: `${newReturn._id}-returnCreated` },
        isRtl
      );

      await emitSocketEvent(io, ['admin', 'production', `branch-${branchId}`], 'returnCreated', {
        returnId: newReturn._id,
        branchId,
        returnNumber: formattedReturn.returnNumber,
        eventId: `${newReturn._id}-returnCreated`,
      });

      res.status(201).json({ success: true, returnRequest: formattedReturn });
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating return:`, err.stack);
    let status = 500;
    let message = err.message;
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير كافية') || message.includes('Insufficient')) status = 422;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
    else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('مطلوب') || message.includes('match')) status = 400;
    else if (err.name === 'ValidationError') status = 400;

    res.status(status).json({ success: false, message });
  }
};

const approveReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    await retryTransaction(async (session) => {
      const { id } = req.params;
      const { status, reviewNotes = '' } = req.body;

      if (!isValidObjectId(id)) {
        throw new Error(isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID');
      }
      if (!['approved', 'rejected'].includes(status)) {
        throw new Error(isRtl ? 'حالة غير صالحة' : 'Invalid status');
      }
      if (req.user.role !== 'admin' && req.user.role !== 'production') {
        throw new Error(isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Not authorized to approve return');
      }

      const returnRequest = await Return.findById(id).session(session);
      if (!returnRequest) {
        throw new Error(isRtl ? 'الإرجاع غير موجود' : 'Return not found');
      }
      if (returnRequest.status !== 'pending_approval') {
        throw new Error(isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval');
      }

      let adjustedTotal = 0;
      if (status === 'approved') {
        for (const item of returnRequest.items) {
          // Clear pending stock and permanently deduct
          await updateInventoryStock({
            branch: returnRequest.branch,
            product: item.product,
            quantity: -item.quantity,
            type: 'return_approved',
            reference: `Approved return #${returnRequest.returnNumber}`,
            referenceType: 'return',
            referenceId: returnRequest._id,
            createdBy: req.user.id,
            session,
            notes: `${item.reason} (${item.reasonEn})`,
            isPending: false,
            isRtl,
          });
          await Inventory.findOneAndUpdate(
            { branch: returnRequest.branch, product: item.product },
            { $inc: { pendingStock: -item.quantity } },
            { session }
          );
          adjustedTotal += item.quantity * item.price;
        }
      } else if (status === 'rejected') {
        for (const item of returnRequest.items) {
          // Move pending stock to damaged stock
          await updateInventoryStock({
            branch: returnRequest.branch,
            product: item.product,
            quantity: item.quantity,
            type: 'return_rejected',
            reference: `Rejected return #${returnRequest.returnNumber}`,
            referenceType: 'return',
            referenceId: returnRequest._id,
            createdBy: req.user.id,
            session,
            isDamaged: true,
            notes: `${item.reason} (${item.reasonEn})`,
            isRtl,
          });
          await Inventory.findOneAndUpdate(
            { branch: returnRequest.branch, product: item.product },
            { $inc: { pendingStock: -item.quantity } },
            { session }
          );
        }
      }

      returnRequest.status = status;
      returnRequest.reviewNotes = reviewNotes.trim();
      returnRequest.reviewedBy = req.user.id;
      returnRequest.reviewedAt = new Date();
      returnRequest.statusHistory.push({
        status,
        changedBy: req.user.id,
        notes: reviewNotes.trim(),
        changedAt: new Date(),
      });
      await returnRequest.save({ session });

      // Update linked orders
      for (const ordId of returnRequest.orders) {
        const ord = await Order.findById(ordId).session(session);
        if (ord) {
          ord.adjustedTotal = ord.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
          if (status === 'approved') {
            ord.adjustedTotal -= adjustedTotal;
          }
          await ord.save({ session });
        }
      }

      // Populate return data
      const populatedReturn = await Return.findById(id)
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('orders', 'orderNumber')
        .populate('createdBy', 'name nameEn username')
        .populate('reviewedBy', 'name nameEn username')
        .session(session)
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: {
          ...populatedReturn.branch,
          displayName: isRtl ? (populatedReturn.branch?.name || 'غير معروف') : (populatedReturn.branch?.nameEn || populatedReturn.branch?.name || 'Unknown'),
        },
        items: populatedReturn.items.map(item => ({
          ...item,
          product: {
            ...item.product,
            displayName: isRtl ? (item.product?.name || 'غير معروف') : (item.product?.nameEn || item.product?.name || 'Unknown'),
            displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
            department: item.product?.department ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
            } : null,
          },
          reasonDisplay: isRtl ? item.reason : item.reasonEn,
        })),
        createdByDisplay: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'Unknown'),
        reviewedByDisplay: isRtl ? (populatedReturn.reviewedBy?.name || 'غير معروف') : (populatedReturn.reviewedBy?.nameEn || populatedReturn.reviewedBy?.name || 'Unknown'),
      };

      // Commit transaction
      await session.commitTransaction();

      // Notify users
      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: returnRequest.branch },
        ],
      }).select('_id branch').lean();

      const branchName = populatedReturn.branch?.name || 'غير معروف';
      await notifyUsers(
        io,
        usersToNotify,
        'returnStatusUpdated',
        isRtl ? `تم تحديث حالة طلب الإرجاع ${populatedReturn.returnNumber} إلى ${status} بواسطة ${branchName}` : `Return request ${populatedReturn.returnNumber} status updated to ${status} by ${populatedReturn.branch?.nameEn || branchName}`,
        { returnId: id, branchId: returnRequest.branch, status, eventId: `${id}-returnStatusUpdated` },
        isRtl
      );

      await emitSocketEvent(io, ['admin', 'production', `branch-${returnRequest.branch}`], 'returnStatusUpdated', {
        returnId: id,
        branchId: returnRequest.branch,
        status,
        returnNumber: populatedReturn.returnNumber,
        eventId: `${id}-returnStatusUpdated`,
      });

      res.status(200).json({ success: true, returnRequest: { ...formattedReturn, adjustedTotal } });
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error approving return:`, err.stack);
    let status = 500;
    let message = err.message;
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير كافية') || message.includes('Insufficient')) status = 422;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
    else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('pending')) status = 400;
    else if (err.name === 'ValidationError') status = 400;

    res.status(status).json({ success: false, message });
  }
};

module.exports = { createReturn, approveReturn };