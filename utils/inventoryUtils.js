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
  isRtl = true, // Default to true for Arabic environments
}) => {
  if (!mongoose.Types.ObjectId.isValid(branch) || !mongoose.Types.ObjectId.isValid(product)) {
    console.error(`[${new Date().toISOString()}] updateInventoryStock - Invalid branch or product ID:`, { branch, product });
    throw new Error(isRtl ? 'معرف الفرع أو المنتج غير صالح' : 'Invalid branch or product ID');
  }
  if (quantity === 0) {
    console.error(`[${new Date().toISOString()}] updateInventoryStock - Quantity cannot be zero:`, { quantity });
    throw new Error(isRtl ? 'الكمية يجب ألا تكون صفر' : 'Quantity cannot be zero');
  }

  console.log(`[${new Date().toISOString()}] updateInventoryStock - Updating inventory stock:`, {
    branch,
    product,
    quantity,
    type,
    reference,
    referenceId,
    isDamaged,
    isPending,
  });

  const update = {
    $inc: {
      currentStock: isPending ? -quantity : (isDamaged ? 0 : quantity),
      pendingStock: isPending ? quantity : 0,
      damagedStock: isDamaged ? quantity : 0,
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
      pendingStock: 0,
      damagedStock: 0,
    },
  };

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
  });
  await historyEntry.save({ session });

  console.log(`[${new Date().toISOString()}] updateInventoryStock - Inventory and history updated:`, {
    inventoryId: inventory._id,
    historyId: historyEntry._id,
  });

  return inventory;
};

module.exports = { updateInventoryStock };