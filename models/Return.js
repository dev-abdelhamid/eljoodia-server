const mongoose = require('mongoose');
const { returnReasonMapping } = require('../helpers');

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    unique: true,
    required: true,
    trim: true,
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
  items: [
    {
      order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        required: true, // الآن مطلوب per item
      },
      itemId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false,
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
      price: {
        type: Number,
        required: true,
        min: 0,
      },
      reason: {
        type: String,
        enum: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
        required: true,
      },
      reasonEn: {
        type: String,
        enum: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
        required: true,
      },
      notes: {
        type: String,
        trim: true,
      },
    },
  ],
  reason: {
    type: String,
    enum: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
    required: true,
  },
  reasonEn: {
    type: String,
    enum: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
    required: true,
  },
  totalReturnValue: {
    type: Number,
    default: 0,
    min: 0,
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
  createdAt: {
    type: Date,
    default: Date.now,
  },
  notes: {
    type: String,
    trim: true,
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
    trim: true,
  },
  statusHistory: [
    {
      status: String,
      changedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      notes: String,
      changedAt: {
        type: Date,
        default: Date.now,
      },
    },
  ],
}, { timestamps: true });

// Pre-save: auto fill reasonEn and calculate total
returnSchema.pre('save', function (next) {
  this.reasonEn = returnReasonMapping[this.reason] || this.reason;
  this.items.forEach((item) => {
    item.reasonEn = returnReasonMapping[item.reason] || item.reason;
  });
  this.totalReturnValue = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  this.orders = [...new Set(this.items.map(i => i.order))]; // Extract unique orders from items
  next();
});

module.exports = mongoose.model('Return', returnSchema);