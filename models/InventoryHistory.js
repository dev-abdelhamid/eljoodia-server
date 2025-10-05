// models/InventoryHistory.js
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
    enum: ['delivery', 'return_pending', 'return_rejected', 'return_approved', 'sale', 'sale_cancelled', 'sale_deleted', 'restock', 'adjustment'],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  reference: {
    type: String,
    trim: true,
    required: false,
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