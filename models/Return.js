const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema({
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
  price: {
    type: Number,
    required: true,
  },
  reason: {
    type: String,
    required: true,
    enum: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
  },
  reasonEn: {
    type: String,
    required: false, // Make reasonEn optional
    default: function () {
      const reasonMap = {
        'تالف': 'Damaged',
        'منتج خاطئ': 'Wrong Item',
        'كمية زائدة': 'Excess Quantity',
        'أخرى': 'Other',
      };
      return reasonMap[this.reason] || 'Other';
    },
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: false,
  },
});

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    required: true,
    unique: true,
  },
  orders: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
  }],
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  items: [returnItemSchema],
  reason: {
    type: String,
    enum: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
    required: false,
  },
  reasonEn: {
    type: String,
    required: false,
    default: function () {
      const reasonMap = {
        'تالف': 'Damaged',
        'منتج خاطئ': 'Wrong Item',
        'كمية زائدة': 'Excess Quantity',
        'أخرى': 'Other',
      };
      return reasonMap[this.reason] || 'Other';
    },
  },
  status: {
    type: String,
    enum: ['pending_approval', 'approved', 'rejected'],
    default: 'pending_approval',
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
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: {
    type: Date,
  },
  reviewNotes: {
    type: String,
    default: '',
  },
  statusHistory: [{
    status: {
      type: String,
      enum: ['pending_approval', 'approved', 'rejected'],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: {
      type: String,
      default: '',
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
  damaged: {
    type: Boolean,
    default: false,
  },
});

module.exports = mongoose.model('Return', returnSchema);