const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

async function updateInventoryStock(options) {
  const { branch, product, quantity, type, reference, referenceType, referenceId, createdBy, session, isDamaged = false } = options;

  const updateField = isDamaged ? 'damagedStock' : 'currentStock';
  const movementType = quantity > 0 ? 'in' : 'out';

  const update = {
    $inc: { [updateField]: quantity },
    $push: {
      movements: {
        type: movementType,
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
      damagedStock: 0,
      movements: [],
    },
  };

  const inventory = await Inventory.findOneAndUpdate(
    { branch, product },
    update,
    { upsert: true, new: true, session }
  );

  const history = new InventoryHistory({
    product,
    branch,
    action: type,
    quantity,
    reference,
    referenceType,
    referenceId,
    createdBy,
    notes: options.notes || '',
  });
  await history.save({ session });

  return inventory;
}

module.exports = { updateInventoryStock };