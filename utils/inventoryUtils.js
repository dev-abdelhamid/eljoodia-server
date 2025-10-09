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
  const updates = {
    $inc: {
      currentStock: isPending ? -quantity : 0, // خصم من currentStock عند الإرجاع المعلق
      pendingReturnStock: isPending ? quantity : isDamaged ? -quantity : 0, // إضافة إلى pendingReturnStock أو خصم عند الرفض
      damagedStock: isDamaged ? quantity : 0, // إضافة إلى damagedStock عند الرفض
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
  };

  const inventory = await Inventory.findOneAndUpdate(
    { branch, product },
    {
      ...updates,
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
  });
  await historyEntry.save({ session });

  return inventory;
};

module.exports = { updateInventoryStock };