const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

async function updateInventoryStock(options) {
  const {
    branch,
    product,
    quantity,
    type,
    reference,
    referenceType,
    referenceId,
    createdBy,
    session,
    isDamaged = false,
    notes = '',
    isRtl = false, // قيمة افتراضية لـ isRtl
  } = options;

  // التحقق من صحة البيانات
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
  });

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
    notes,
  });
  await history.save({ session });

  console.log(`[${new Date().toISOString()}] updateInventoryStock - Inventory and history updated:`, {
    inventoryId: inventory._id,
    historyId: history._id,
  });

  return inventory;
}

module.exports = { updateInventoryStock };