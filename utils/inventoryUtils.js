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
  const inventory = await Inventory.findOneAndUpdate(
    { branch, product },
    {
      $inc: { 
        currentStock: quantity,
        ...(isDamaged ? { damagedStock: quantity } : {}),
      },
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
  });
  await historyEntry.save({ session });

  return inventory;
};

module.exports = { updateInventoryStock };