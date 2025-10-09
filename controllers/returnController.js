const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const { updateInventoryStock } = require('../utils/inventoryUtils');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // Non-transaction validations
    const { branchId, items, notes = '', orders = [] } = req.body;

    if (!isValidObjectId(branchId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    if (!Array.isArray(items) || !items.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'العناصر مطلوبة' : 'Items are required' });
    }
    const validOrders = orders.filter(isValidObjectId);
    if (validOrders.length !== orders.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بعض معرفات الطلبات غير صالحة' : 'Some order IDs are invalid' });
    }
    const reasonMap = { 'تالف': 'Damaged', 'منتج خاطئ': 'Wrong Item', 'كمية زائدة': 'Excess Quantity', 'أخرى': 'Other' };
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!isValidObjectId(item.product) || !item.quantity || item.quantity < 1 || !item.reason) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `بيانات العنصر ${i + 1} غير صالحة` : `Invalid item data at index ${i}` });
      }
      if (!reasonMap[item.reason]) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'سبب الإرجاع غير صالح' : 'Invalid return reason' });
      }
      if (item.reasonEn && item.reasonEn !== reasonMap[item.reason]) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'سبب الإرجاع بالإنجليزية غير متطابق' : 'English reason does not match Arabic reason' });
      }
    }
    if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch' });
    }

    // Transactional operations
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    const productIds = items.map(i => i.product);
    const possibleOrders = await Order.find({
      branch: branchId,
      status: 'delivered',
      'items.product': { $in: productIds },
    }).select('_id').session(session);
    const linkedOrders = [...new Set([...validOrders, ...possibleOrders.map(o => o._id)])];

    for (const item of items) {
      const product = await Product.findById(item.product).session(session);
      if (!product) {
        await session.abortTransaction();
        throw new Error(isRtl ? `المنتج ${item.product} غير موجود` : `Product ${item.product} not found`);
      }
      item.price = product.price;
      item.reasonEn = item.reasonEn || reasonMap[item.reason];

      const inventory = await Inventory.findOne({ branch: branch._id, product: item.product }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        await session.abortTransaction();
        throw new Error(isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}`);
      }
    }

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

    for (const ordId of linkedOrders) {
      const ord = await Order.findById(ordId).session(session);
      if (ord) {
        if (!ord.returns) ord.returns = [];
        if (!ord.returns.includes(newReturn._id)) ord.returns.push(newReturn._id);
        await ord.save({ session });
      }
    }

    for (const item of items) {
      await updateInventoryStock({
        branch: branch._id,
        product: item.product,
        quantity: -item.quantity,
        type: 'return_pending',
        reference: `Return ${returnNumber}`,
        referenceType: 'return',
        referenceId: newReturn._id,
        createdBy: req.user.id,
        session,
        notes: `${item.reason} (${item.reasonEn})`,
      });
    }

    await session.commitTransaction();

    // Post-transaction: Populate response
    const populatedReturn = await Return.findById(newReturn._id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('orders', 'orderNumber')
      .populate('createdBy', 'name nameEn username')
      .lean();

    if (!populatedReturn) {
      throw new Error(isRtl ? 'فشل في جلب بيانات الإرجاع' : 'Failed to fetch return data');
    }

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

    // Non-blocking notifications
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: branchId },
      ],
    }).select('_id branch').lean();

    const branchName = populatedReturn.branch?.name || 'غير معروف';
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'returnCreated',
        isRtl ? `طلب إرجاع جديد ${formattedReturn.returnNumber} من ${branchName}` : `New return request ${formattedReturn.returnNumber} from ${populatedReturn.branch?.nameEn || branchName}`,
        { returnId: newReturn._id, branchId, eventId: `${newReturn._id}-returnCreated` },
        io,
        true
      );
    }

    res.status(201).json({ success: true, returnRequest: formattedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, err.stack);
    let status = 500;
    let message = err.message;
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير كافية') || message.includes('Insufficient')) status = 422;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
    else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('مطلوب') || message.includes('match')) status = 400;
    else if (err.name === 'ValidationError') status = 400;

    res.status(status).json({ success: false, message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes = '' } = req.body;

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
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Not authorized to approve return' });
    }

    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
    }
    if (returnRequest.status !== 'pending_approval') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval' });
    }

    let adjustedTotal = 0;
    if (status === 'approved') {
      for (const item of returnRequest.items) {
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
        });
        adjustedTotal += item.quantity * item.price;
      }
    } else if (status === 'rejected') {
      for (const item of returnRequest.items) {
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
        });
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

    await session.commitTransaction();

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

    // Non-blocking notifications
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.branch },
      ],
    }).select('_id branch').lean();

    const branchName = populatedReturn.branch?.name || 'غير معروف';
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'returnStatusUpdated',
        isRtl ? `تم تحديث حالة طلب الإرجاع ${populatedReturn.returnNumber} إلى ${status} بواسطة ${branchName}` : `Return request ${populatedReturn.returnNumber} status updated to ${status} by ${populatedReturn.branch?.nameEn || branchName}`,
        { returnId: id, branchId: returnRequest.branch, status, eventId: `${id}-returnStatusUpdated` },
        io,
        true
      );
    }

    res.status(200).json({ success: true, returnRequest: { ...formattedReturn, adjustedTotal } });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, err.stack);
    let status = 500;
    let message = err.message;
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير كافية') || message.includes('Insufficient')) status = 422;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
    else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('pending')) status = 400;
    else if (err.name === 'ValidationError') status = 400;

    res.status(status).json({ success: false, message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };