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
    },
  ],
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
    required: false,
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
    },
  ],
}, { timestamps: true });

const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
};

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

returnSchema.virtual('displayReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.reason : this.reasonEn;
});

returnSchema.virtual('items.$*.displayReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.reason : this.reasonEn;
});

returnSchema.virtual('displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : this.notes || 'N/A';
});

returnSchema.virtual('statusHistory.$*.displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : this.notes || 'N/A';
});

returnSchema.set('toJSON', { virtuals: true });
returnSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Return || mongoose.model('Return', returnSchema);