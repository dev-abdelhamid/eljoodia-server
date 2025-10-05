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
    enum: ['restock', 'adjustment', 'return', 'transfer_in', 'transfer_out', 'limits_update', 'damaged'],
    required: true,
  },
  field: {
    type: String,
    enum: ['stock', 'min_level', 'max_level', 'damaged'],
    required: false,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0,
  },
  reference: {
    type: String,
    required: true,
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
  transferDetails: {
    fromBranch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
    },
    toBranch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
    },
    transferId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transfer',
    },
  },
});

inventoryHistorySchema.index({ product: 1, branch: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);