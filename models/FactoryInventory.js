const mongoose = require('mongoose');

const factoryInventorySchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
  currentStock: {
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
  movements: [{
    type: {
      type: String,
      enum: ['in', 'out', 'allocated'],
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

module.exports = mongoose.model('FactoryInventory', factoryInventorySchema);
