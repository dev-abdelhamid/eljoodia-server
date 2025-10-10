const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'معرف المنتج مطلوب' : 'Product ID is required'],
  },
  quantity: {
    type: Number,
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'الكمية مطلوبة' : 'Quantity is required'],
    min: [1, (value, { req }) => req.query.lang === 'ar' ? 'الكمية يجب أن تكون أكبر من 0' : 'Quantity must be greater than 0'],
  },
  price: {
    type: Number,
    min: [0, (value, { req }) => req.query.lang === 'ar' ? 'السعر يجب أن يكون غير سالب' : 'Price must be non-negative'],
    default: 0, // Price is derived from Product model
  },
  reason: {
    type: String,
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع مطلوب' : 'Return reason is required'],
    enum: {
      values: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
      message: (value, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع غير صالح' : 'Invalid return reason',
    },
  },
  reasonEn: {
    type: String,
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع بالإنجليزية مطلوب' : 'English return reason is required'],
    enum: {
      values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
      message: (value, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع بالإنجليزية غير صالح' : 'Invalid English return reason',
    },
  },
});

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'رقم الإرجاع مطلوب' : 'Return number is required'],
    unique: true,
  },
  orders: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
  }],
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'معرف الفرع مطلوب' : 'Branch ID is required'],
  },
  items: [returnItemSchema],
  status: {
    type: String,
    enum: {
      values: ['pending_approval', 'approved', 'rejected'],
      message: (value, { req }) => req.query.lang === 'ar' ? 'حالة الإرجاع غير صالحة' : 'Invalid return status',
    },
    default: 'pending_approval',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'معرف المستخدم مطلوب' : 'User ID is required'],
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

// Indexes for performance
returnSchema.index({ branch: 1, createdAt: -1 });
returnSchema.index({ returnNumber: 1 });
returnSchema.index({ status: 1 });

module.exports = mongoose.model('Return', returnSchema);