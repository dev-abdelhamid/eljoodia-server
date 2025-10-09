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
  try {
    if (!mongoose.isValidObjectId(branch) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(createdBy)) {
      throw new Error('Invalid branch, product, or user ID');
    }

    const updates = {
      $inc: {
        currentStock: isPending ? -quantity : type === 'return_rejected' ? quantity : 0,
        pendingReturnStock: isPending ? quantity : type === 'return_approved' || type === 'return_rejected' ? -quantity : 0,
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

    if (inventory.currentStock < 0 || inventory.pendingReturnStock < 0 || inventory.damagedStock < 0) {
      throw new Error('Stock cannot be negative');
    }

    const historyEntry = new InventoryHistory({
      product,
      branch,
      action: type,
      quantity: type === 'return_rejected' ? quantity : -quantity,
      reference,
      referenceType,
      referenceId,
      createdBy,
      notes,
      createdAt: new Date(),
    });
    await historyEntry.save({ session });

    console.log(`[${new Date().toISOString()}] Inventory updated:`, {
      product,
      branch,
      type,
      quantity,
      currentStock: inventory.currentStock,
      pendingReturnStock: inventory.pendingReturnStock,
      damagedStock: inventory.damagedStock,
    });

    return inventory;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error updating inventory stock:`, {
      message: error.message,
      stack: error.stack,
      branch,
      product,
      type,
      quantity,
    });
    throw error;
  }
};

module.exports = { updateInventoryStock };