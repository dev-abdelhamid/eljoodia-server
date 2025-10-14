// utils/factoryInventoryUtils.js
const mongoose = require('mongoose');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const updateFactoryInventoryStock = async ({
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
  isShipPending = false,
}) => {
  try {
    if (!mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(createdBy)) {
      throw new Error('Invalid product or user ID');
    }
    const inventory = await FactoryInventory.findOne({ product }).session(session);
    if (!inventory) {
      const newInventory = new FactoryInventory({
        product,
        createdBy,
        minStockLevel: 0,
        maxStockLevel: 1000,
        currentStock: 0,
        pendingReturnStock: 0,
        pendingShipStock: 0,
        damagedStock: 0,
      });
      await newInventory.save({ session });
    }
    const currentInventory = await FactoryInventory.findOne({ product }).session(session);
    const updates = {
      $inc: {
        currentStock: isPending ? -quantity : type === 'return_rejected' ? quantity : (type === 'reserve' || type === 'produced_reserved') ? (type === 'produced_reserved' ? 0 : -quantity) : (type === 'produced_stock' ? quantity : 0),
        pendingReturnStock: isPending ? quantity : type === 'return_approved' || type === 'return_rejected' ? -quantity : 0,
        pendingShipStock: isShipPending ? quantity : (type === 'shipped' ? -quantity : 0),
        damagedStock: isDamaged ? quantity : 0,
        __v: 1,
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
    const updatedInventory = await FactoryInventory.findOneAndUpdate(
      { product, __v: currentInventory.__v },
      updates,
      { new: true, session }
    );
    if (!updatedInventory) {
      throw new Error('Failed to update factory inventory due to version conflict');
    }
    if (updatedInventory.currentStock < 0 || updatedInventory.pendingReturnStock < 0 || updatedInventory.pendingShipStock < 0 || updatedInventory.damagedStock < 0) {
      throw new Error('Stock cannot be negative');
    }
    const historyEntry = new FactoryInventoryHistory({
      product,
      action: type,
      quantity: type === 'return_rejected' || type === 'produced_stock' ? quantity : -quantity,
      reference,
      referenceType,
      referenceId,
      createdBy,
      notes,
      createdAt: new Date(),
    });
    await historyEntry.save({ session });
    console.log(`[${new Date().toISOString()}] Factory inventory updated:`, {
      product,
      type,
      quantity,
      currentStock: updatedInventory.currentStock,
      pendingShipStock: updatedInventory.pendingShipStock,
    });
    return updatedInventory;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error updating factory inventory stock:`, error);
    throw error;
  }
};
module.exports = { updateFactoryInventoryStock };