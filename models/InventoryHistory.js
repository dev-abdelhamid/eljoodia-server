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
    enum: ['restock', 'adjustment', 'return_pending', 'return_approved', 'return_rejected', 'limits_adjustment'],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  reference: {
    type: String,
    required: true,
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
});

inventoryHistorySchema.index({ branch: 1, product: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);