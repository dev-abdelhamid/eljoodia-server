const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
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
  currentStock: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
  },
  damagedStock: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
  },
  minStockLevel: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
  },
  maxStockLevel: {
    type: Number,
    min: 0,
    default: 0,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  movements: [{
    type: {
      type: String,
      enum: ['in', 'out'],
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
  }],
}, { timestamps: true });

module.exports = mongoose.model('Inventory', inventorySchema);