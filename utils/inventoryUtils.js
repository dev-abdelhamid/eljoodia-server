const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

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
  const updateFields = {};
  if (type === 'return_pending') {
    updateFields.currentStock = -quantity; // Decrease currentStock
    updateFields.pendingReturnStock = quantity; // Increase pendingReturnStock
  } else if (type === 'return_approved') {
    updateFields.pendingReturnStock = -quantity; // Decrease pendingReturnStock
    if (isDamaged) {
      updateFields.damagedStock = quantity; // Increase damagedStock
    }
  } else if (type === 'return_rejected') {
    updateFields.pendingReturnStock = -quantity; // Decrease pendingReturnStock
    updateFields.currentStock = quantity; // Increase currentStock
  } else {
    updateFields.currentStock = quantity;
  }

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
};

module.exports = { updateInventoryStock };