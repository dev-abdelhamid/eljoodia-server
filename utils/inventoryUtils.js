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
  isPending = false,
}) => {
  const update = {
    $setOnInsert: {
      product,
      branch,
      createdBy,
      minStockLevel: 0,
      maxStockLevel: 1000,
      currentStock: 0,
      damagedStock: 0,
      pendingReturnStock: 0,
    },
    $push: {
      movements: {
        type: quantity >= 0 ? 'in' : 'out',
        quantity: Math.abs(quantity),
        reference,
        createdBy,
        createdAt: new Date(),
      },
    },
  };

  // Handle stock updates based on type and status
  if (type === 'return_pending') {
    update.$inc = { currentStock: quantity, pendingReturnStock: Math.abs(quantity) };
  } else if (type === 'return_approved') {
    update.$inc = { pendingReturnStock: -Math.abs(quantity) }; // Remove from pending
  } else if (type === 'return_rejected') {
    update.$inc = { pendingReturnStock: -Math.abs(quantity), damagedStock: Math.abs(quantity) }; // Move to damaged
  } else {
    update.$inc = { currentStock: quantity };
    if (isDamaged) {
      update.$inc.damagedStock = Math.abs(quantity);
    }
  }

  const inventory = await Inventory.findOneAndUpdate(
    { branch, product },
    update,
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
    isPending,
  });
  await historyEntry.save({ session });

  return inventory;
};

module.exports = { updateInventoryStock };