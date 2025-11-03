const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true,
    trim: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  items: [{
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'in_progress', 'completed'],
      default: 'pending',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    returnedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnReason: {
      type: String,
      enum: {
        values: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى', ''],
        message: '{VALUE} ليس سبب إرجاع صالح'
      },
      trim: true,
      required: false,
    },
    returnReasonEn: {
      type: String,
      enum: {
        values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other', ''],
        message: '{VALUE} is not a valid return reason'
      },
      trim: true,
      required: false,
    },
  }],
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  adjustedTotal: {
    type: Number,
    default: 0,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'],
    default: 'pending',
  },
  notes: {
    type: String,
    trim: true,
    required: false,
  },
  notesEn: {
    type: String,
    trim: true,
    required: false,
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
    required: false,
    trim: true,
  },
  requestedDeliveryDate: {
    type: Date,
    required: false,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: { type: Date },
  deliveredAt: { type: Date },
  transitStartedAt: { type: Date },
  returns: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Return',
  }],
  statusHistory: [{
    status: String,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: {
      type: String,
      trim: true,
      required: false,
    },
    notesEn: {
      type: String,
      trim: true,
      required: false,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
});

// Mapping للـ returnReason
const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
  '': ''
};

// Pre-save: ملء returnReasonEn تلقائيًا
orderSchema.pre('save', function(next) {
  this.items.forEach(item => {
    if (item.returnReason) {
      item.returnReasonEn = returnReasonMapping[item.returnReason] || item.returnReason;
    } else {
      item.returnReasonEn = '';
    }
  });
  next();
});

// Virtual لـ displayReturnReason
orderSchema.virtual('items.$*.displayReturnReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl 
    ? (this.returnReason || 'غير محدد') 
    : (this.returnReasonEn || this.returnReason || 'N/A');
});

// Virtual لـ displayNotes
orderSchema.virtual('displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl 
    ? (this.notes || 'غير محدد') 
    : (this.notesEn || this.notes || 'N/A');
});

// Virtual لـ statusHistory.displayNotes
orderSchema.virtual('statusHistory.$*.displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl 
    ? (this.notes || 'غير محدد') 
    : (this.notesEn || this.notes || 'N/A');
});

// Pre-save: حسابات + تحديث الحالة + تاريخ الـ returns
orderSchema.pre('save', async function(next) {
  try {
    // لا تحقق من مطابقة الأقسام أبدًا
    // فقط تأكد من أن الحالة تُحدّث عند التعيين
    for (const item of this.items) {
      if (item.assignedTo && item.status === 'pending') {
        item.status = 'assigned';
      }
    }

    // حساب المبلغ الإجمالي والمُعدّل
    const returns = await mongoose.model('Return').find({ 
      _id: { $in: this.returns }, 
      status: 'approved' 
    });
    const returnAdjustments = returns.reduce((sum, ret) => sum + (ret.totalReturnValue || 0), 0);

    this.totalAmount = this.items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    this.adjustedTotal = this.totalAmount - returnAdjustments;

    // تحديث حالة الطلب بناءً على العناصر
    if (this.isModified('items')) {
      const allCompleted = this.items.every(i => i.status === 'completed');
      if (allCompleted && !['completed', 'in_transit', 'delivered'].includes(this.status)) {
        this.status = 'completed';
        this.statusHistory.push({
          status: 'completed',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
        });
      }
    }

    if (this.isModified('items') && this.status === 'approved') {
      const hasInProgress = this.items.some(i => i.status === 'in_progress');
      if (hasInProgress && this.status !== 'in_production') {
        this.status = 'in_production';
        this.statusHistory.push({
          status: 'in_production',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
        });
      }
    }

    // إضافة تاريخ للـ returns المعتمدة
    for (const ret of returns) {
      if (!this.statusHistory.some(h => h.notes?.includes(`Return approved for ID: ${ret._id}`))) {
        this.statusHistory.push({
          status: this.status,
          changedBy: ret.approvedBy || 'system',
          notes: `Return approved for ID: ${ret._id}, reasons: ${ret.items.map(i => i.reason).join(', ')}`,
          notesEn: `Return approved for ID: ${ret._id}, reasons: ${ret.items.map(i => i.reasonEn).join(', ')}`,
          changedAt: new Date(),
        });
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

// الفهرسة
orderSchema.index({ orderNumber: 1, branch: 1, 'items.returnReasonEn': 1 });

// تفعيل الـ virtuals
orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);