const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

const updateInventoryStock = async ({ branchId, productId, quantity, operation, type, description, session }) => {
  try {
    if (!mongoose.isValidObjectId(branchId) || !mongoose.isValidObjectId(productId)) {
      throw new Error('Invalid branchId or productId');
    }
    
    if (!quantity || quantity < 0) {
      throw new Error('Quantity must be a positive number');
    }

    const inventory = await Inventory.findOne({ branch: branchId, product: productId }).session(session);
    if (!inventory) {
      throw new Error('Inventory record not found');
    }

    // التحقق من الكمية قبل التحديث
    if (operation === 'decrement' && inventory.currentStock < quantity) {
      throw new Error(`Insufficient stock: requested ${quantity}, available ${inventory.currentStock}`);
    }

    const update = operation === 'increment' 
      ? { $inc: { currentStock: quantity, pendingReturnStock: type === 'return_pending' ? quantity : 0 } }
      : { $inc: { currentStock: -quantity, pendingReturnStock: type === 'return_pending' ? -quantity : 0 } };

    await Inventory.updateOne(
      { _id: inventory._id },
      update,
      { session }
    );

    // تسجيل التاريخ
    const historyEntry = new InventoryHistory({
      branch: branchId,
      product: productId,
      quantity: operation === 'increment' ? quantity : -quantity,
      type,
      description,
      createdAt: new Date(),
    });

    await historyEntry.save({ session });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in updateInventoryStock:`, {
      branchId,
      productId,
      quantity,
      operation,
      type,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
};

module.exports = { updateInventoryStock };