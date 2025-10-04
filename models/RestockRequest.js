const mongoose = require('mongoose');

const restockRequestSchema = new mongoose.Schema({
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
  requestedQuantity: {
    type: Number,
    required: true,
    min: 1,
  },
  approvedQuantity: {
    type: Number,
    default: null,
    min: 0,
  },
  notes: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  approvedAt: {
    type: Date,
    default: null,
  },
});

restockRequestSchema.index({ branch: 1, createdAt: -1 });

module.exports = mongoose.model('RestockRequest', restockRequestSchema);