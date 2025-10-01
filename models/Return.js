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
  items: [
    {
      itemId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
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
        enum: {
          values: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
          message: '{VALUE} ليس سبب إرجاع صالح',
        },
        required: true,
        trim: true,
      },
      reasonEn: {
        type: String,
        enum: {
          values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
          message: '{VALUE} is not a valid return reason',
        },
        required: true,
        trim: true,
      },
      notes: {
        type: String,
        trim: true,
      },
    },
  ],
  reason: {
    type: String,
    enum: {
      values: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
      message: '{VALUE} ليس سبب إرجاع صالح',
    },
    required: true,
    trim: true,
  },
  reasonEn: {
    type: String,
    enum: {
      values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
      message: '{VALUE} is not a valid return reason',
    },
    required: true,
    trim: true,
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
      status: {
        type: String,
        enum: ['pending_approval', 'approved', 'rejected'],
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
}, { timestamps: true });

// خريطة أسباب الإرجاع
const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
};

// قبل الحفظ، ضمان توافق الأسباب ثنائية اللغة
returnSchema.pre('save', function (next) {
  if (this.reason && !this.reasonEn) {
    this.reasonEn = returnReasonMapping[this.reason] || this.reason;
  }
  this.items.forEach((item) => {
    if (item.reason && !item.reasonEn) {
      item.reasonEn = returnReasonMapping[item.reason] || item.reason;
    }
  });
  next();
});

// حقول ظاهرية لعرض البيانات حسب اللغة
returnSchema.virtual('displayReason').get(function () {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.reason : this.reasonEn;
});

returnSchema.set('toJSON', { virtuals: true });
returnSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Return || mongoose.model('Return', returnSchema);