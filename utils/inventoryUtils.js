const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

// تحديث مخزون العنصر
const updateInventoryStock = async ({
  branch,
  product,
  quantity,
  type,
  reference,
  referenceType,
  referenceId,
  createdBy,
  session,
  notes = '',
  isDamaged = false,
}) => {
  try {
    const updateFields = {};
    if (type === 'return_pending') {
      updateFields.currentStock = -quantity; // تقليل المخزون الحالي
      updateFields.pendingReturnStock = quantity; // زيادة المخزون المحجوز
    } else if (type === 'return_approved') {
      updateFields.pendingReturnStock = -quantity; // تقليل المخزون المحجوز
      if (isDamaged) {
        updateFields.damagedStock = quantity; // زيادة المخزون التالف
      }
    } else if (type === 'return_rejected') {
      updateFields.pendingReturnStock = -quantity; // تقليل المخزون المحجوز
      updateFields.currentStock = quantity; // إعادة المخزون الحالي
    } else {
      updateFields.currentStock = quantity;
    }

    // تحديث المخزون بشكل ذري
    const inventory = await Inventory.findOneAndUpdate(
      { branch, product },
      {
        $inc: updateFields,
        $push: {
          movements: {
            type: quantity > 0 ? 'in' : 'out',
            quantity: Math.abs(quantity),
            reference,
            createdBy,
            createdAt: new Date(),
          },
        },
        $setOnInsert: {
          product,
          branch,
          createdBy,
          minStockLevel: 0,
          maxStockLevel: 1000,
          currentStock: 0,
          pendingReturnStock: 0,
          damagedStock: 0,
        },
      },
      { upsert: true, new: true, session }
    );

    // إنشاء سجل في تاريخ المخزون
    const historyEntry = new InventoryHistory({
      product,
      branch,
      action: type,
      quantity,
      reference,
      referenceType,
      referenceId,
      createdBy,
      notes,
      isDamaged,
    });
    await historyEntry.save({ session });

    return inventory;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في تحديث المخزون:`, {
      error: err.message,
      stack: err.stack,
      branch,
      product,
      quantity,
      type,
    });
    throw err;
  }
};

module.exports = { updateInventoryStock };