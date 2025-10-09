// utils/inventoryUtils.js (assuming this file for updateInventoryStock)
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

const updateInventoryStock = async ({ branch, product, quantity, type, reference, createdBy, session, isDamaged = false }) => {
  const updateField = isDamaged ? 'damagedStock' : 'currentStock';
  const movementType = quantity > 0 ? 'in' : 'out';

  const inventory = await Inventory.findOneAndUpdate(
    { branch, product },
    {
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
    },
    { new: true, session }
  );

  const historyEntry = new InventoryHistory({
    product,
    branch,
    action: type,
    quantity,
    reference,
    createdBy,
  });
  await historyEntry.save({ session });

  return inventory;
};

module.exports = { updateInventoryStock };