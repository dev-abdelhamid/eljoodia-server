const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    unique: true,
    required: true,
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
      message: '{VALUE} ليس سبب إرجاع صالح'
    },
    required: false,  // optional لو عاوز، بس كده كان required
    trim: true,
  },
  reasonEn: {
    type: String,
    enum: {
      values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
      message: '{VALUE} is not a valid return reason'
    },
    required: false,
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
          message: '{VALUE} ليس سبب إرجاع صالح'
        },
        required: false,  // optional
        trim: true,
      },
      reasonEn: {
        type: String,
        enum: {
          values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
          message: '{VALUE} is not a valid return reason'
        },
        required: false,
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
    required: false  // optional
  },
});

// Mapping نفسه
const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other'
};

// Pre-save: ملء En auto لـ reason وitems.reason
returnSchema.pre('save', function(next) {
  if (this.reason) {
    this.reasonEn = returnReasonMapping[this.reason] || this.reason;
  }
  this.items.forEach(item => {
    if (item.reason) {
      item.reasonEn = returnReasonMapping[item.reason] || item.reason;
    }
  });
  next();
});

// Virtuals لـ displayReason وitems.displayReason
returnSchema.virtual('displayReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.reason || 'غير محدد') : (this.reasonEn || this.reason || 'N/A');
});

returnSchema.virtual('items.$*.displayReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.reason || 'غير محدد') : (this.reasonEn || this.reason || 'N/A');
});

returnSchema.set('toJSON', { virtuals: true });
returnSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Return', returnSchema);