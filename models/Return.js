const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    unique: true,
    required: [true, 'رقم الإرجاع مطلوب'],
    trim: true,
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: [true, 'الطلب مطلوب'],
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'الفرع مطلوب'],
  },
  reason: {
    type: String,
    enum: {
      values: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
      message: 'سبب إرجاع غير صالح',
    },
    required: [true, 'سبب الإرجاع مطلوب'],
    trim: true,
  },
  reasonEn: {
    type: String,
    enum: {
      values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
      message: 'سبب إرجاع إنجليزي غير صالح',
    },
    required: true,
    trim: true,
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'المنتج مطلوب'],
    },
    quantity: {
      type: Number,
      required: [true, 'الكمية مطلوبة'],
      min: [1, 'الكمية يجب أن تكون أكبر من صفر'],
    },
    reason: {
      type: String,
      enum: {
        values: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
        message: 'سبب إرجاع العنصر غير صالح',
      },
      required: [true, 'سبب إرجاع العنصر مطلوب'],
      trim: true,
    },
    reasonEn: {
      type: String,
      enum: {
        values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
        message: 'سبب إرجاع العنصر بالإنجليزية غير صالح',
      },
      required: true,
      trim: true,
    },
  }],
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  notes: {
    type: String,
    trim: true,
    required: false,
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: {
    type: Date,
  },
  statusHistory: [{
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
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
      required: false,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, { timestamps: true });

// Mapping للأسباب
const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
};

// Pre-save middleware لملء reasonEn تلقائيًا
returnSchema.pre('save', function(next) {
  if (this.reason && !this.reasonEn) {
    this.reasonEn = returnReasonMapping[this.reason] || this.reason;
  }
  this.items.forEach(item => {
    if (item.reason && !item.reasonEn) {
      item.reasonEn = returnReasonMapping[item.reason] || item.reason;
    }
  });
  next();
});

// Virtuals لعرض الأسباب حسب اللغة
returnSchema.virtual('displayReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.reason : this.reasonEn;
});

returnSchema.virtual('items.$*.displayReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.reason : this.reasonEn;
});

// Virtual لعرض الملاحظات حسب اللغة (اختياري)
returnSchema.virtual('displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'لا توجد ملاحظات') : (this.notes || 'No notes');
});

returnSchema.set('toJSON', { virtuals: true });
returnSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Return || mongoose.model('Return', returnSchema);