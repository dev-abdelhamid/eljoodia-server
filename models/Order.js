const mongoose = require('mongoose');
const { updateInventoryStock } = require('../utils/inventoryUtils');

// Mapping for return reasons to align with frontend ReturnReason enum
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
    required: [true, '{PATH} is required'],
    trim: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, '{PATH} is required'],
  },
  items: [{
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, '{PATH} is required'],
    },
    quantity: {
      type: Number,
      required: [true, '{PATH} is required'],
      min: [1, 'Quantity must be at least 1'],
    },
    price: {
      type: Number,
      required: [true, '{PATH} is required'],
      min: [0, 'Price cannot be negative'],
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'assigned', 'in_progress', 'completed'],
        message: '{VALUE} is not a valid item status'
      },
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
      min: [0, 'Returned quantity cannot be negative'],
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
    required: [true, '{PATH} is required'],
    min: [0, 'Total amount cannot be negative'],
  },
  adjustedTotal: {
    type: Number,
    default: 0,
    min: [0, 'Adjusted total cannot be negative'],
  },
  status: {
    type: String,
    enum: {
      values: ['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'],
      message: '{VALUE} is not a valid order status'
    },
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
    enum: {
      values: ['low', 'medium', 'high', 'urgent'],
      message: '{VALUE} is not a valid priority'
    },
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
    required: [true, '{PATH} is required'],
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
    status: {
      type: String,
      required: true,
    },
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
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Virtual for displayReturnReason
orderSchema.virtual('items.$*.displayReturnReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.returnReason || 'غير محدد') : (this.returnReasonEn || this.returnReason || 'N/A');
});

// Virtual for displayNotes
orderSchema.virtual('displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

// Virtual for statusHistory.displayNotes
orderSchema.virtual('statusHistory.$*.displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

// Pre-save: Sync returnReasonEn with returnReason
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

// Pre-save: Validate and update inventory, chef assignments, and order status
orderSchema.pre('save', async function(next) {
  try {
    const isRtl = this.options?.context?.isRtl ?? true;

    // Validate chef assignments and department compatibility
    for (const item of this.items) {
      if (item.assignedTo) {
        const product = await mongoose.model('Product').findById(item.product);
        const chef = await mongoose.model('User').findById(item.assignedTo);
        if (product && chef && chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
          return next(new Error(isRtl
            ? `الشيف ${chef.name} لا يمكنه التعامل مع قسم ${product.department}`
            : `Chef ${chef.name} cannot handle department ${product.department}`));
        }
        item.status = item.status || 'assigned';
      }
    }

    // Update totalAmount and adjustedTotal
    this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
    const returns = await mongoose.model('Return').find({ _id: { $in: this.returns }, status: 'approved' });
    const returnAdjustments = returns.reduce((sum, ret) => sum + ret.totalReturnValue, 0);
    this.adjustedTotal = this.totalAmount - returnAdjustments;

    // Update inventory when order status changes to 'delivered'
    if (this.isModified('status') && this.status === 'delivered') {
      for (const item of this.items) {
        const inventory = await mongoose.model('Inventory').findOne({
          branch: this.branch,
          product: item.product,
        });
        if (!inventory) {
          return next(new Error(isRtl
            ? `عنصر المخزون غير موجود للمنتج ${item.product}`
            : `Inventory item not found for product ${item.product}`));
        }
        if (inventory.currentStock < item.quantity) {
          return next(new Error(isRtl
            ? `الكمية غير كافية للمنتج ${item.product} في المخزون`
            : `Insufficient quantity for product ${item.product} in inventory`));
        }
        await updateInventoryStock({
          branch: this.branch,
          product: item.product,
          quantity: -item.quantity, // Deduct from inventory
          type: 'order',
          reference: isRtl
            ? `تأكيد تسليم الطلبية #${this.orderNumber}`
            : `Order delivery confirmation #${this.orderNumber}`,
          referenceType: 'order',
          referenceId: this._id,
          createdBy: this.createdBy,
          session: this.$session(),
          isRtl,
        });
      }
      this.deliveredAt = new Date();
      this.statusHistory.push({
        status: 'delivered',
        changedBy: this.approvedBy || this.createdBy || 'system',
        changedAt: new Date(),
        notes: isRtl ? `تم تسليم الطلبية #${this.orderNumber}` : `Order #${this.orderNumber} delivered`,
        notesEn: `Order #${this.orderNumber} delivered`,
      });
    }

    // Update order status based on item statuses
    if (this.isModified('items')) {
      const allCompleted = this.items.every(i => i.status === 'completed');
      if (allCompleted && !['completed', 'in_transit', 'delivered'].includes(this.status)) {
        this.status = 'completed';
        this.statusHistory.push({
          status: 'completed',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
          notes: isRtl ? `اكتمال جميع عناصر الطلبية` : `All order items completed`,
          notesEn: `All order items completed`,
        });
      }
    }

    // Update status to in_production if items are in progress
    if (this.isModified('items') && this.status === 'approved') {
      const hasInProgress = this.items.some(i => i.status === 'in_progress');
      if (hasInProgress) {
        this.status = 'in_production';
        this.statusHistory.push({
          status: 'in_production',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
          notes: isRtl ? `بدء إنتاج الطلبية` : `Order production started`,
          notesEn: `Order production started`,
        });
      }
    }

    // Add history for approved returns
    for (const ret of returns) {
      if (!this.statusHistory.some(h => h.notes?.includes(`Return approved for ID: ${ret._id}`))) {
        this.statusHistory.push({
          status: this.status,
          changedBy: ret.approvedBy || 'system',
          notes: isRtl
            ? `تمت الموافقة على الإرجاع ${ret._id}, الأسباب: ${ret.items.map(i => i.reason).join(', ')}`
            : `Return approved for ID: ${ret._id}, reasons: ${ret.items.map(i => i.reasonEn).join(', ')}`,
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

// Indexes for performance
orderSchema.index({ orderNumber: 1, branch: 1 });
orderSchema.index({ 'items.product': 1 });
orderSchema.index({ 'items.returnReasonEn': 1 });
orderSchema.index({ status: 1, branch: 1 });

module.exports = mongoose.model('Order', orderSchema);