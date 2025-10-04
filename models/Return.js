const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    required: true,
    unique: true,
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  reason: {
    type: String,
    required: true,
  },
  items: [{
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending_approval', 'approved', 'rejected'],
      default: 'pending_approval',
    },
    reviewNotes: {
      type: String,
      default: null,
    },
  }],
  notes: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: ['pending_approval', 'approved', 'rejected', 'partially_processed'],
    default: 'pending_approval',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  processedAt: {
    type: Date,
    default: null,
  },
});

returnSchema.index({ returnNumber: 1 }, { unique: true });
returnSchema.index({ branch: 1, createdAt: -1 });

module.exports = mongoose.model('Return', returnSchema);