const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'معرف المنتج مطلوب'],
  },
  quantity: {
    type: Number,
    required: [true, 'الكمية مطلوبة'],
    min: [1, 'الكمية يجب أن تكون أكبر من 0'],
  },
  price: {
    type: Number,
    required: [true, 'السعر مطلوب'],
    min: [0, 'السعر يجب أن يكون غير سالب'],
  },
  reason: {
    type: String,
    required: [true, 'سبب الإرجاع مطلوب'],
    enum: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
  },
  reasonEn: {
    type: String,
    required: [true, 'سبب الإرجاع بالإنجليزية مطلوب'],
    enum: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
  },
});

returnItemSchema.pre('save', function (next) {
  const reasonMap = {
    'تالف': 'Damaged',
    'منتج خاطئ': 'Wrong Item',
    'كمية زائدة': 'Excess Quantity',
    'أخرى': 'Other',
  };
  if (this.reason && !this.reasonEn) {
    this.reasonEn = reasonMap[this.reason];
  }
  if (this.reasonEn && this.reason && reasonMap[this.reason] !== this.reasonEn) {
    return next(new Error('reason and reasonEn must correspond'));
  }
  next();
});

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    required: [true, 'رقم الإرجاع مطلوب'],
    unique: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'معرف الفرع مطلوب'],
  },
  items: [returnItemSchema],
  status: {
    type: String,
    enum: ['pending_approval', 'approved', 'rejected'],
    default: 'pending_approval',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المستخدم مطلوب'],
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  notes: {
    type: String,
    trim: true,
    default: '',
  },
  reviewNotes: {
    type: String,
    trim: true,
    default: '',
  },
  reviewedAt: {
    type: Date,
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
      trim: true,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

module.exports = mongoose.model('Return', returnSchema);