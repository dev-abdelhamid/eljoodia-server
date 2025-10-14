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
      min: 1,
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

// Virtual لـ displayNotes
orderSchema.virtual('displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

// Virtual لـ statusHistory.displayNotes
orderSchema.virtual('statusHistory.$*.displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

// Middleware للتحقق من تعيين الشيفات والتأكد من مطابقة الأقسام
orderSchema.pre('save', async function(next) {
  try {
    for (const item of this.items) {
      if (item.assignedTo) {
        const product = await mongoose.model('Product').findById(item.product);
        const chef = await mongoose.model('User').findById(item.assignedTo);
        if (product && chef && chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
          return next(new Error(isRtl ? `الشيف ${chef.name} لا يمكنه التعامل مع قسم ${product.department}` : `Chef ${chef.name} cannot handle department ${product.department}`));
        }
        item.status = item.status || 'assigned';
      }
    }
    this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
    this.adjustedTotal = this.totalAmount;
    // تحديث حالة الطلب بناءً على حالة العناصر
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
    next();
  } catch (err) {
    next(err);
  }
});

orderSchema.index({ orderNumber: 1, branch: 1 });
orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);