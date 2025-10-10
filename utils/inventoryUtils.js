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

    // Check for existing history entry to prevent duplication
    const existingHistory = await InventoryHistory.findOne({
      branch,
      product,
      action: type,
      referenceId,
      referenceType,
    }).session(session);
    if (existingHistory) {
      throw new Error('Inventory history entry already exists for this action');
    }

    let inventory = await Inventory.findOne({ branch, product }).session(session);
    if (!inventory) {
      inventory = new Inventory({
        product,
        branch,
        createdBy,
        minStockLevel: 0,
        maxStockLevel: 1000,
        currentStock: 0,
        pendingReturnStock: 0,
        damagedStock: 0,
      });
      await inventory.save({ session });
    }

    const currentInventory = await Inventory.findOne({ branch, product }).session(session);

    const updates = {
      $inc: {
        currentStock: type === 'sale' || type === 'delivery' ? -quantity : (isPending ? -quantity : type === 'return_rejected' ? quantity : 0),
        pendingReturnStock: isPending ? quantity : type === 'return_approved' || type === 'return_rejected' ? -quantity : 0,
        damagedStock: isDamaged ? quantity : 0,
        __v: 1,
      },
      $push: {
        movements: {
          type: quantity > 0 && type !== 'sale' ? 'in' : 'out',
          quantity: Math.abs(quantity),
          reference,
          createdBy,
          createdAt: new Date(),
        },
      },
    };

    const updatedInventory = await Inventory.findOneAndUpdate(
      { branch, product, __v: currentInventory.__v },
      updates,
      { new: true, session }
    );

    if (!updatedInventory) {
      throw new Error('Failed to update inventory due to version conflict');
    }

    if (updatedInventory.currentStock < 0 || updatedInventory.pendingReturnStock < 0 || updatedInventory.damagedStock < 0) {
      throw new Error('Stock cannot be negative');
    }

    const historyEntry = new InventoryHistory({
      product,
      branch,
      action: type,
      quantity: type === 'sale' || type === 'delivery' || type === 'return_rejected' ? -quantity : quantity,
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
      currentStock: updatedInventory.currentStock,
      pendingReturnStock: updatedInventory.pendingReturnStock,
      damagedStock: updatedInventory.damagedStock,
    });

    return updatedInventory;
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