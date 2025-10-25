const mongoose = require('mongoose');

// Mapping for return reasons
const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
  '': ''
};

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
    unit: {
      type: String,
      enum: {
        values: ['كيلو', 'قطعة', 'علبة', 'صينية', ''],
        message: '{VALUE} ليست وحدة قياس صالحة'
      },
      trim: true,
      required: true,
    },
    unitEn: {
      type: String,
      enum: {
        values: ['Kilo', 'Piece', 'Pack', 'Tray', ''],
        message: '{VALUE} is not a valid English unit'
      },
      trim: true,
      required: true,
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

// Pre-save: Auto-fill returnReasonEn and validate quantity based on unit
orderSchema.pre('save', async function(next) {
  try {
    for (const item of this.items) {
      // Auto-fill returnReasonEn
      if (item.returnReason) {
        item.returnReasonEn = returnReasonMapping[item.returnReason] || item.returnReason;
      } else {
        item.returnReasonEn = '';
      }
      // Validate quantity based on unit
      const product = await mongoose.model('Product').findById(item.product);
      if (!product) {
        return next(new Error(this.options?.context?.isRtl ? `المنتج ${item.product} غير موجود` : `Product ${item.product} not found`));
      }
      if (product.unit !== item.unit || product.unitEn !== item.unitEn) {
        return next(new Error(this.options?.context?.isRtl ? `الوحدة غير متطابقة للمنتج ${item.product}` : `Unit mismatch for product ${item.product}`));
      }
      if (item.unit === 'قطعة' || item.unit === 'علبة' || item.unit === 'صينية') {
        if (!Number.isInteger(item.quantity)) {
          return next(new Error(this.options?.context?.isRtl ? `الكمية يجب أن تكون عددًا صحيحًا لوحدة ${item.unit}` : `Quantity must be an integer for unit ${item.unitEn}`));
        }
      }
      // Chef assignment validation
      if (item.assignedTo) {
        const chef = await mongoose.model('User').findById(item.assignedTo);
        if (chef && chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
          return next(new Error(this.options?.context?.isRtl ? `الشيف ${chef.name} لا يمكنه التعامل مع قسم ${product.department}` : `Chef ${chef.name} cannot handle department ${product.department}`));
        }
        item.status = item.status || 'assigned';
      }
    }
    // Calculate total amount considering returns
    const returns = await mongoose.model('Return').find({ _id: { $in: this.returns }, status: 'approved' });
    const returnAdjustments = returns.reduce((sum, ret) => sum + ret.totalReturnValue, 0);
    this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
    this.adjustedTotal = this.totalAmount - returnAdjustments;
    // Update order status based on item statuses
    if (this.isModified('items')) {
      const allCompleted = this.items.every(i => i.status === 'completed');
      if (allCompleted && this.status !== 'completed' && this.status !== 'in_transit' && this.status !== 'delivered') {
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
      if (hasInProgress) {
        this.status = 'in_production';
        this.statusHistory.push({
          status: 'in_production',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
        });
      }
    }
    // Add history for approved returns
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

orderSchema.index({ orderNumber: 1, branch: 1, 'items.returnReasonEn': 1 });
orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);