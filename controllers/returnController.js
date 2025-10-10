const mongoose = require('mongoose');
const Return = require('../models/Return');
const Inventory = require('../models/Inventory');
const { updateInventoryStock } = require('../utils/inventoryUtils');
const { generateReturnNumber } = require('../utils/helpers');

const createReturn = async (req, res) => {
  const { branchId, orders, items, notes } = req.body;
  const isRtl = req.query.lang === 'ar';
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // Validate branch and items
    const branchExists = await mongoose.model('Branch').findById(branchId).session(session);
    if (!branchExists) {
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    // Validate items against inventory
    for (const item of items) {
      const inventory = await Inventory.findOne({ branch: branchId, product: item.product }).session(session);
      if (!inventory) {
        throw new Error(isRtl ? `المنتج ${item.product} غير موجود في المخزون` : `Product ${item.product} not found in inventory`);
      }
      if (inventory.currentStock < item.quantity) {
        throw new Error(isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}`);
      }
    }

    // Create return request
    const returnNumber = await generateReturnNumber();
    const returnRequest = new Return({
      returnNumber,
      branch: branchId,
      orders: orders || [],
      items,
      createdBy: req.user._id,
      notes,
    });

    // Update inventory for each item
    for (const item of items) {
      await updateInventoryStock({
        branch: branchId,
        product: item.product,
        quantity: -item.quantity, // Decrease currentStock
        type: 'return_pending',
        reference: returnNumber,
        referenceType: 'return',
        referenceId: returnRequest._id,
        createdBy: req.user._id,
        session,
        notes,
        isDamaged: item.reason === 'تالف' || item.reasonEn === 'Damaged',
      });
    }

    await returnRequest.save({ session });
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      message: isRtl ? 'تم إنشاء طلب الإرجاع بنجاح' : 'Return request created successfully',
      returnRequest,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, {
      error: err.message,
      stack: err.stack,
      body: req.body,
    });
    res.status(400).json({
      success: false,
      message: isRtl ? err.message || 'خطأ في إنشاء طلب الإرجاع' : err.message || 'Error creating return request',
      errors: err.errors || [],
    });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const { id } = req.params;
  const { status, reviewNotes } = req.body;
  const isRtl = req.query.lang === 'ar';
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      throw new Error(isRtl ? 'طلب الإرجاع غير موجود' : 'Return request not found');
    }

    if (returnRequest.status !== 'pending_approval') {
      throw new Error(isRtl ? 'طلب الإرجاع ليس في انتظار الموافقة' : 'Return request is not pending approval');
    }

    // Aggregate updates by product and branch to avoid conflicts
    const inventoryUpdates = {};
    for (const item of returnRequest.items) {
      const key = `${returnRequest.branch}_${item.product}`;
      if (!inventoryUpdates[key]) {
        inventoryUpdates[key] = {
          branch: returnRequest.branch,
          product: item.product,
          quantity: 0,
          isDamaged: item.reason === 'تالف' || item.reasonEn === 'Damaged',
        };
      }
      inventoryUpdates[key].quantity += status === 'approved' ? -item.quantity : item.quantity;
    }

    // Apply inventory updates
    for (const key in inventoryUpdates) {
      const update = inventoryUpdates[key];
      await updateInventoryStock({
        branch: update.branch,
        product: update.product,
        quantity: update.quantity,
        type: status === 'approved' ? 'return_approved' : 'return_rejected',
        reference: returnRequest.returnNumber,
        referenceType: 'return',
        referenceId: returnRequest._id,
        createdBy: req.user._id,
        session,
        notes: reviewNotes,
        isDamaged: update.isDamaged && status === 'approved',
      });
    }

    // Update return request
    returnRequest.status = status;
    returnRequest.reviewedBy = req.user._id;
    returnRequest.reviewedAt = new Date();
    returnRequest.reviewNotes = reviewNotes || '';
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user._id,
      notes: reviewNotes,
      changedAt: new Date(),
    });

    await returnRequest.save({ session });
    await session.commitTransaction();

    // Emit socket event
    req.io.emit('returnStatusUpdated', {
      branchId: returnRequest.branch.toString(),
      returnId: returnRequest._id.toString(),
      status,
      eventId: crypto.randomUUID(),
    });

    res.status(200).json({
      success: true,
      message: isRtl
        ? `تم ${status === 'approved' ? 'الموافقة على' : 'رفض'} طلب الإرجاع بنجاح`
        : `Return request ${status === 'approved' ? 'approved' : 'rejected'} successfully`,
      returnRequest,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving/rejecting return:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? err.message || 'خطأ في السيرفر' : err.message || 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };