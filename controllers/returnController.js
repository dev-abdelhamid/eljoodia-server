const mongoose = require('mongoose');
const Order = require('../models/Order');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper function to handle translations
const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

// Retry logic for transient transaction errors
const withRetry = async (operation, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const result = await operation(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction();
      if (error.errorLabels?.includes('TransientTransactionError') && attempt < maxRetries) {
        console.log(`[${new Date().toISOString()}] Retry ${attempt + 1} after transaction failure:`, error.message);
        continue;
      }
      throw error;
    } finally {
      session.endSession();
    }
  }
};

// Create a return request
const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';

  try {
    const result = await withRetry(async (session) => {
      // Non-transaction validations
      const { branchId, items, notes = '', orders = [] } = req.body;

      if (!isValidObjectId(branchId)) {
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: isRtl ? 'العناصر مطلوبة' : 'Items are required' });
      }
      const validOrders = orders.filter(isValidObjectId);
      if (validOrders.length !== orders.length) {
        return res.status(400).json({ success: false, message: isRtl ? 'بعض معرفات الطلبات غير صالحة' : 'Some order IDs are invalid' });
      }
      const reasonMap = { 'تالف': 'Damaged', 'منتج خاطئ': 'Wrong Item', 'كمية زائدة': 'Excess Quantity', 'أخرى': 'Other' };
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!isValidObjectId(item.product) || !item.quantity || item.quantity < 1 || !item.reason) {
          return res.status(400).json({ success: false, message: isRtl ? `بيانات العنصر ${i + 1} غير صالحة` : `Invalid item data at index ${i}` });
        }
        if (!reasonMap[item.reason]) {
          return res.status(400).json({ success: false, message: isRtl ? 'سبب الإرجاع غير صالح' : 'Invalid return reason' });
        }
        if (item.reasonEn && item.reasonEn !== reasonMap[item.reason]) {
          return res.status(400).json({ success: false, message: isRtl ? 'سبب الإرجاع بالإنجليزية غير متطابق' : 'English reason does not match Arabic reason' });
        }
      }
      if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch' });
      }

      // Transactional operations
      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      const productIds = items.map(i => i.product);
      const possibleOrders = await Order.find({
        branch: branchId,
        status: 'delivered',
        'items.product': { $in: productIds },
      }).select('_id').session(session);
      const linkedOrders = [...new Set([...validOrders, ...possibleOrders.map(o => o._id)])];

      // Validate products and stock
      for (const item of items) {
        const product = await Product.findById(item.product).session(session);
        if (!product) {
          return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.product} غير موجود` : `Product ${item.product} not found` });
        }
        item.price = product.price;
        item.reasonEn = item.reasonEn || reasonMap[item.reason];

        const inventory = await Inventory.findOne({ branch: branch._id, product: item.product }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          return res.status(422).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}` });
        }
      }

      // Generate unique return number
      const returnCount = await Return.countDocuments({ branch: branchId }).session(session);
      const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(returnCount + 1).toString().padStart(4, '0')}`;

      // Create return document
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
        statusHistory: [{
          status: 'pending_approval',
          changedBy: req.user.id,
          changedAt: new Date(),
        }],
      });
      await newReturn.save({ session });

      // Update linked orders
      for (const ordId of linkedOrders) {
        const ord = await Order.findById(ordId).session(session);
        if (ord) {
          if (!ord.returns) ord.returns = [];
          if (!ord.returns.includes(newReturn._id)) ord.returns.push(newReturn._id);
          await ord.save({ session });
        }
      }

      // Update inventory and log history
      for (const item of items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch: branch._id, product: item.product, currentStock: { $gte: item.quantity } },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `طلب إرجاع ${returnNumber} (${item.reason})`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { session, new: true }
        );

        if (!inventory) {
          return res.status(422).json({
            success: false,
            message: isRtl ? `فشل تحديث المخزون للمنتج ${item.product} بسبب الكمية غير الكافية` : `Failed to update inventory for product ${item.product} due to insufficient quantity`,
          });
        }

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: branch._id,
          action: 'return_pending',
          quantity: -item.quantity,
          reference: `طلب إرجاع ${returnNumber} (${item.reason})`,
          referenceType: 'return',
          referenceId: newReturn._id,
          createdBy: req.user.id,
          notes: `${item.reason} (${item.reasonEn})`,
        });
        await historyEntry.save({ session });
      }

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
        .session(session)
        .lean();

      if (!populatedReturn) {
        return res.status(500).json({ success: false, message: isRtl ? 'فشل في جلب بيانات الإرجاع' : 'Failed to fetch return data' });
      }

      const formattedReturn = {
        ...populatedReturn,
        branch: {
          ...populatedReturn.branch,
          displayName: translateField(populatedReturn.branch, 'name', lang),
        },
        items: populatedReturn.items.map(item => ({
          ...item,
          product: {
            ...item.product,
            displayName: translateField(item.product, 'name', lang),
            displayUnit: translateField(item.product, 'unit', lang) || (isRtl ? 'غير محدد' : 'N/A'),
            department: item.product?.department ? {
              ...item.product.department,
              displayName: translateField(item.product.department, 'name', lang),
            } : null,
          },
          reasonDisplay: isRtl ? item.reason : item.reasonEn,
        })),
        createdByDisplay: translateField(populatedReturn.createdBy, 'name', lang),
      };

      // Emit notification
      req.app.get('io')?.emit('returnCreated', {
        branchId,
        returnId: newReturn._id.toString(),
        status: 'pending_approval',
        eventId: `${newReturn._id}-returnCreated`,
      });

      console.log(`[${new Date().toISOString()}] Created return successfully:`, {
        returnId: newReturn._id,
        returnNumber,
        branchId,
        itemCount: items.length,
        userId: req.user.id,
      });

      return res.status(201).json({ success: true, returnRequest: formattedReturn });
    });

    return result;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating return:`, err.stack);
    let status = 500;
    let message = err.message;
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير كافية') || message.includes('Insufficient') || message.includes('فشل تحديث المخزون')) status = 422;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
    else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('مطلوب') || message.includes('match')) status = 400;
    else if (err.name === 'ValidationError') status = 400;

    return res.status(status).json({ success: false, message });
  }
};

// Approve or reject a return
const approveReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';

  try {
    const result = await withRetry(async (session) => {
      const { id } = req.params;
      const { status, reviewNotes = '' } = req.body;

      if (!isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
      }
      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ success: false, message: isRtl ? 'حالة غير صالحة' : 'Invalid status' });
      }
      if (req.user.role !== 'admin' && req.user.role !== 'production') {
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Not authorized to approve return' });
      }

      const returnRequest = await Return.findById(id).session(session);
      if (!returnRequest) {
        return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
      }
      if (returnRequest.status !== 'pending_approval') {
        return res.status(400).json({ success: false, message: isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval' });
      }

      let adjustedTotal = 0;
      for (const item of returnRequest.items) {
        const update = {
          $push: {
            movements: {
              type: status === 'approved' ? 'return_approved' : 'return_rejected',
              quantity: item.quantity,
              reference: `${status === 'approved' ? 'موافقة' : 'رفض'} إرجاع #${returnRequest.returnNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        };

        if (status === 'rejected') {
          update.$inc = { damagedStock: item.quantity };
        }

        const inventory = await Inventory.findOneAndUpdate(
          { branch: returnRequest.branch, product: item.product },
          update,
          { session, new: true }
        );

        if (!inventory) {
          return res.status(404).json({
            success: false,
            message: isRtl ? `المخزون غير موجود للمنتج ${item.product}` : `Inventory not found for product ${item.product}`,
          });
        }

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: returnRequest.branch,
          action: status === 'approved' ? 'return_approved' : 'return_rejected',
          quantity: status === 'approved' ? 0 : item.quantity, // No stock change on approval, add to damaged on rejection
          reference: `${status === 'approved' ? 'موافقة' : 'رفض'} إرجاع #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          notes: `${item.reason} (${item.reasonEn})`,
        });
        await historyEntry.save({ session });

        adjustedTotal += item.quantity * item.price;
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
        .session(session)
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: {
          ...populatedReturn.branch,
          displayName: translateField(populatedReturn.branch, 'name', lang),
        },
        items: populatedReturn.items.map(item => ({
          ...item,
          product: {
            ...item.product,
            displayName: translateField(item.product, 'name', lang),
            displayUnit: translateField(item.product, 'unit', lang) || (isRtl ? 'غير محدد' : 'N/A'),
            department: item.product?.department ? {
              ...item.product.department,
              displayName: translateField(item.product.department, 'name', lang),
            } : null,
          },
          reasonDisplay: isRtl ? item.reason : item.reasonEn,
        })),
        createdByDisplay: translateField(populatedReturn.createdBy, 'name', lang),
        reviewedByDisplay: translateField(populatedReturn.reviewedBy, 'name', lang),
      };

      // Emit notification
      req.app.get('io')?.emit('returnStatusUpdated', {
        branchId: returnRequest.branch.toString(),
        returnId: id,
        status,
        eventId: `${id}-returnStatusUpdated`,
      });

      console.log(`[${new Date().toISOString()}] Updated return status successfully:`, {
        returnId: id,
        status,
        userId: req.user.id,
      });

      return res.status(200).json({ success: true, returnRequest: { ...formattedReturn, adjustedTotal } });
    });

    return result;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error approving return:`, err.stack);
    let status = 500;
    let message = err.message;
    if (message.includes('غير موجود') || message.includes('not found')) status = 404;
    else if (message.includes('غير كافية') || message.includes('Insufficient')) status = 422;
    else if (message.includes('غير مخول') || message.includes('authorized')) status = 403;
    else if (message.includes('غير صالح') || message.includes('Invalid') || message.includes('pending')) status = 400;
    else if (err.name === 'ValidationError') status = 400;

    return res.status(status).json({ success: false, message });
  }
};

module.exports = { createReturn, approveReturn };