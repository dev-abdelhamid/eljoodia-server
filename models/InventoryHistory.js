// ../models/InventoryHistory.js
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
  type: {
    type: String,
    enum: ['in', 'out', 'return_approved', 'sale', 'restock', 'adjustment'],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0,
  },
  reference: {
    type: String,
    trim: true,
    required: false, // Optional, as some movements (e.g., adjustments) may not have a reference
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
    required: false,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);