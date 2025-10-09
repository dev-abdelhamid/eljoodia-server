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
  isPending = false,
  isDamaged = false,
}) => {
  try {
    const inventory = await Inventory.findOne({ branch, product }).session(session);
    if (!inventory) {
      throw new Error('Inventory not found');
    }

    if (type === 'return_pending') {
      inventory.currentStock -= quantity;
      inventory.pendingReturnStock += quantity;
    } else if (type === 'return_approved') {
      inventory.pendingReturnStock -= quantity;
      if (isDamaged) {
        inventory.damagedStock += quantity;
      }
    } else if (type === 'return_rejected') {
      inventory.pendingReturnStock -= quantity;
      inventory.currentStock += quantity;
    } else {
      inventory.currentStock += quantity;
    }

    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      branch,
      product,
      quantity,
      type,
      reference,
      referenceType,
      referenceId,
      createdBy,
      notes,
    });
    await historyEntry.save({ session });

    return inventory;
  } catch (err) {
    throw new Error(`Failed to update inventory: ${err.message}`);
  }
};

module.exports = { updateInventoryStock };