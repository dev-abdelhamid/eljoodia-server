const mongoose = require('mongoose');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const { updateInventoryStock } = require('../utils/inventoryUtils');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper to generate unique return number
const generateReturnNumber = async (branchId, session) => {
  const count = await Return.countDocuments({ branch: branchId }).session(session);
  return `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(count + 1).toString().padStart(4, '0')}`;
};

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';

  try {
    const { branchId, items, notes = '', orders = [] } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId)) {
      throw new Error(isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID');
    }
    if (!Array.isArray(items) || !items.length) {
      throw new Error(isRtl ? 'العناصر مطلوبة' : 'Items are required');
    }
    if (orders.some(id => !isValidObjectId(id))) {
      throw new Error(isRtl ? 'معرفات الطلبات غير صالحة' : 'Invalid order IDs');
    }

    // Validate branch
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    // Validate user authorization
    if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
      throw new Error(isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch');
    }

    // Map productId to product for backward compatibility
    const processedItems = items.map(item => ({
      product: item.product || item.productId,
      quantity: item.quantity,
      reason: item.reason,
      reasonEn: item.reasonEn,
    }));

    // Validate items
    const reasonMap = {
      'تالف': 'Damaged',
      'منتج خاطئ': 'Wrong Item',
      'كمية زائدة': 'Excess Quantity',
      'أخرى': 'Other',
    };
    for (const [index, item] of processedItems.entries()) {
      if (!item.product || !isValidObjectId(item.product)) {
        throw new Error(isRtl ? `معرف المنتج غير صالح في العنصر ${index + 1}` : `Invalid product ID at item ${index + 1}`);
      }
      if (!item.quantity || item.quantity < 1) {
        throw new Error(isRtl ? `الكمية غير صالحة في العنصر ${index + 1}` : `Invalid quantity at item ${index + 1}`);
      }
      if (!item.reason || !reasonMap[item.reason] || item.reasonEn !== reasonMap[item.reason]) {
        throw new Error(isRtl ? `سبب الإرجاع غير صالح في العنصر ${index + 1}` : `Invalid return reason at item ${index + 1}`);
      }
    }

    // Verify products exist
    const productIds = processedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      throw new Error(isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found');
    }

    // Prepare return items
    const returnItems = processedItems.map(item => {
      const product = products.find(p => p._id.toString() === item.product);
      return {
        product: item.product,
        quantity: item.quantity,
        price: product.price || 0,
        reason: item.reason,
        reasonEn: item.reasonEn,
      };
    });

    // Validate inventory stock
    for (const item of returnItems) {
      const inventory = await Inventory.findOne({ branch: branchId, product: item.product }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        throw new Error(isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}`);
      }
    }

    // Create return
    const returnNumber = await generateReturnNumber(branchId, session);
    const newReturn = new Return({
      returnNumber,
      orders,
      branch: branchId,
      items: returnItems,
      status: 'pending_approval',
      createdBy: req.user.id,
      notes,
      statusHistory: [{
        status: 'pending_approval',
        changedBy: req.user.id,
        notes: isRtl ? 'تم إنشاء المرتجع' : 'Return created',
        changedAt: new Date(),
      }],
    });
    await newReturn.save({ session });

    // Update inventory
    for (const item of returnItems) {
      await updateInventoryStock({
        branch: branchId,
        product: item.product,
        quantity: -item.quantity,
        type: 'return_pending',
        reference: `مرتجع #${returnNumber}`,
        referenceType: 'return',
        referenceId: newReturn._id,
        createdBy: req.user.id,
        session,
        notes: `${item.reason} (${item.reasonEn})`,
      });
    }

    await session.commitTransaction();

    // Populate response
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
    }).select('_id').lean();

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'returnCreated',
        isRtl ? `طلب إرجاع جديد ${returnNumber} من ${formattedReturn.branch.displayName}` : `New return request ${returnNumber} from ${formattedReturn.branch.displayName}`,
        { returnId: newReturn._id, branchId, eventId: `${newReturn._id}-returnCreated` },
        io,
        true
      );
    }

    console.log(`[${new Date().toISOString()}] إنشاء مرتجع - تم بنجاح:`, {
      returnId: newReturn._id,
      returnNumber,
      branchId,
      userId: req.user.id,
      itemCount: items.length,
    });

    res.status(201).json({ success: true, returnRequest: formattedReturn });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء المرتجع:`, {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) status = 422;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.name === 'ValidationError') {
      status = 400;
      message = isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error';
    }
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';

  try {
    const { id } = req.params;
    const { status, reviewNotes = '' } = req.body;

    // Validate inputs
    if (!isValidObjectId(id)) {
      throw new Error(isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID');
    }
    if (!['approved', 'rejected'].includes(status)) {
      throw new Error(isRtl ? 'حالة غير صالحة' : 'Invalid status');
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      throw new Error(isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Not authorized to approve return');
    }

    // Validate return
    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      throw new Error(isRtl ? 'الإرجاع غير موجود' : 'Return not found');
    }
    if (returnRequest.status !== 'pending_approval') {
      throw new Error(isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval');
    }

    // Update inventory based on status
    let adjustedTotal = 0;
    for (const item of returnRequest.items) {
      const inventory = await Inventory.findOne({ branch: returnRequest.branch, product: item.product }).session(session);
      if (!inventory || inventory.pendingReturnStock < item.quantity) {
        throw new Error(isRtl ? `الكمية المحجوزة غير كافية للمنتج ${item.product}` : `Insufficient reserved quantity for product ${item.product}`);
      }

      if (status === 'approved') {
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: item.product,
          quantity: 0, // No change to currentStock
          type: 'return_approved',
          reference: `مرتجع موافق عليه #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn})`,
          isDamaged: item.reasonEn === 'Damaged',
        });
        adjustedTotal += item.quantity * item.price;
      } else if (status === 'rejected') {
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: item.product,
          quantity: item.quantity,
          type: 'return_rejected',
          reference: `مرتجع مرفوض #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn})`,
        });
      }
    }

    // Update return status
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

    // Populate response
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
    }).select('_id').lean();

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'returnStatusUpdated',
        isRtl ? `تم تحديث حالة المرتجع ${populatedReturn.returnNumber} إلى ${status === 'approved' ? 'موافق عليه' : 'مرفوض'}` : `Return ${populatedReturn.returnNumber} updated to ${status}`,
        { returnId: id, branchId: returnRequest.branch, status, eventId: `${id}-returnStatusUpdated` },
        io,
        true
      );
    }

    console.log(`[${new Date().toISOString()}] تحديث حالة المرتجع - تم بنجاح:`, {
      returnId: id,
      returnNumber: returnRequest.returnNumber,
      status,
      userId: req.user.id,
    });

    res.status(200).json({ success: true, returnRequest: { ...formattedReturn, adjustedTotal } });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تحديث المرتجع:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) status = 422;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid') || err.message.includes('pending')) status = 400;
    else if (err.name === 'ValidationError') {
      status = 400;
      message = isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error';
    }
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };