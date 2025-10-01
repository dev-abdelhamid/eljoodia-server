const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    unique: true,
    required: true,
    trim: true,
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  items: [{
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    productName: { type: String, required: true, trim: true },
    productNameEn: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unit: { type: String, required: true, trim: true },
    unitEn: { type: String, trim: true },
    reason: {
      type: String,
      enum: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
      required: true,
      trim: true,
    },
    reasonEn: {
      type: String,
      enum: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'processed'],
      default: 'pending',
    },
    reviewNotes: { type: String, trim: true },
    reviewNotesEn: { type: String, trim: true },
  }],
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'processed'],
    default: 'pending',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
  notes: { type: String, trim: true },
  notesEn: { type: String, trim: true },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: { type: Date },
  statusHistory: [{
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
    changedByName: { type: String, trim: true },
    notes: { type: String, trim: true },
    notesEn: { type: String, trim: true },
    changedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
};

returnSchema.pre('save', function (next) {
  this.items.forEach(item => {
    if (item.reason && !item.reasonEn) {
      item.reasonEn = returnReasonMapping[item.reason] || item.reason;
    }
    item.displayUnit = this.options?.context?.isRtl ? (item.unit || 'غير محدد') : (item.unitEn || item.unit || 'N/A');
    item.displayReason = this.options?.context?.isRtl ? item.reason : item.reasonEn;
    item.displayReviewNotes = this.options?.context?.isRtl ? (item.reviewNotes || 'غير محدد') : (item.reviewNotesEn || item.reviewNotes || 'N/A');
  });
  if (this.reason && !this.reasonEn) {
    this.reasonEn = returnReasonMapping[this.reason] || this.reason;
  }
  next();
});

returnSchema.virtual('displayReason').get(function () {
  return this.options?.context?.isRtl ? this.reason : this.reasonEn;
});

returnSchema.virtual('displayNotes').get(function () {
  return this.options?.context?.isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

returnSchema.virtual('displayReviewNotes').get(function () {
  return this.options?.context?.isRtl ? (this.reviewNotes || 'غير محدد') : (this.reviewNotesEn || this.reviewNotes || 'N/A');
});

returnSchema.virtual('items.$*.displayUnit').get(function () {
  return this.options?.context?.isRtl ? (this.unit || 'غير محدد') : (this.unitEn || this.unit || 'N/A');
});

returnSchema.virtual('items.$*.displayReason').get(function () {
  return this.options?.context?.isRtl ? this.reason : this.reasonEn;
});

returnSchema.virtual('items.$*.displayReviewNotes').get(function () {
  return this.options?.context?.isRtl ? (this.reviewNotes || 'غير محدد') : (this.reviewNotesEn || this.reviewNotes || 'N/A');
});

returnSchema.virtual('statusHistory.$*.displayNotes').get(function () {
  return this.options?.context?.isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

returnSchema.set('toJSON', { virtuals: true });
returnSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Return', returnSchema);