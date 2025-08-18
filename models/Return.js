const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    unique: true,
    required: true,
    index: true, // Add index for faster queries
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    index: true, // Add index
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true, // Add index
  },
  reason: {
    type: String,
    required: true,
    trim: true,
  },
  items: [
    {
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
        trim: true,
      },
    },
  ],
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'processed'], // Add 'processed'
    default: 'pending',
    index: true, // Add index
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true, // Add index
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: {
    type: Date,
  },
  statusHistory: [
    {
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'processed'],
        required: true,
      },
      changedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      notes: {
        type: String,
        trim: true,
      },
      changedAt: {
        type: Date,
        default: Date.now,
      },
    },
  ],
  notes: {
    type: String,
    trim: true,
  },
  reviewNotes: {
    type: String,
    trim: true,
  },
});

module.exports = mongoose.model('Return', returnSchema);