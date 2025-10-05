const mongoose = require('mongoose');

const inventoryHistorySchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  action: {
    type: String,
    enum: ['delivery', 'return_pending', 'return_approved', 'return_rejected', 'sale', 'sale_cancelled', 'restock', 'adjustment', 'damaged'],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  reference: {
    type: String,
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  notes: {
    type: String,
    trim: true,
  },
});

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);