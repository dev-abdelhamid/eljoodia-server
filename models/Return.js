// models/Return.js
const mongoose = require('mongoose');

// خريطة أسباب الإرجاع
const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
};

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
    required: false, // optional الآن
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
        required: false,
      },
      itemId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false, // optional لو بدون order
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
  totalReturnValue: {
    type: Number,
    default: 0,
    min: 0,
  },
  damaged: {
    type: Boolean,
    default: false,
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

// قبل الحفظ، ضمان توافق الأسباب ثنائية اللغة وحساب totalReturnValue
returnSchema.pre('save', function (next) {
  if (this.reason && !this.reasonEn) {
    this.reasonEn = returnReasonMapping[this.reason] || this.reason;
  }
  this.items.forEach((item) => {
    if (item.reason && !item.reasonEn) {
      item.reasonEn = returnReasonMapping[item.reason] || item.reason;
    }
  });
  this.totalReturnValue = this.items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  next();
});

// Virtual لعرض البيانات حسب اللغة
returnSchema.virtual('displayReason').get(function () {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.reason : this.reasonEn;
});

returnSchema.set('toJSON', { virtuals: true });
returnSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Return || mongoose.model('Return', returnSchema);