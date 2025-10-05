const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

async function updateInventoryStock({ branch, product, quantity, type, reference, createdBy, session, isDamaged = false, field = 'stock' }) {
  const inventory = await Inventory.findOne({ branch, product }).session(session);
  if (!inventory) throw new Error('Inventory not found');

  if (isDamaged) {
    inventory.damagedStock += quantity;
  } else if (field === 'stock') {
    inventory.currentStock += quantity; // + for in, - for out
  } else if (field === 'min_level') {
    inventory.minStockLevel = quantity;
  } else if (field === 'max_level') {
    inventory.maxStockLevel = quantity;
  }

  inventory.lastUpdatedBy = createdBy;
  inventory.movements.push({ type, quantity, reference, createdBy, createdAt: new Date() });
  await inventory.save({ session });

  const history = new InventoryHistory({ product, branch, type, field, quantity, reference, createdBy });
  await history.save({ session });
}

module.exports = { updateInventoryStock };