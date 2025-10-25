const mongoose = require('mongoose');

// Mapping for return reasons
const returnReasonMapping = {
  'تالف': 'Damaged',
  'منتج خاطئ': 'Wrong Item',
  'كمية زائدة': 'Excess Quantity',
  'أخرى': 'Other',
  '': '',
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
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
      min: 0.5, // دعم الكميات العشرية
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: String,
      enum: ['كيلو', 'قطعة', 'علبة', 'صينية'],
      required: true,
    },
    unitEn: {
      type: String,
      enum: ['Kilo', 'Piece', 'Pack', 'Tray'],
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
      enum: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى', ''],
      trim: true,
    },
    returnReasonEn: {
      type: String,
      enum: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other', ''],
      trim: true,
    },
    receivedQuantity: {
      type: Number,
      default: 0, // الكمية المستلمة فعليًا
      min: 0,
    },
    shortageQuantity: {
      type: Number,
      default: 0, // كمية النقص
      min: 0,
    },
    shortageReason: {
      type: String,
      trim: true, // سبب النقص (بالعربية)
    },
    shortageReasonEn: {
      type: String,
      trim: true, // سبب النقص (بالإنجليزية)
    },
  }],
  shortages: [{
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
      min: 0.5, // دعم الكميات العشرية
    },
    unit: {
      type: String,
      enum: ['كيلو', 'قطعة', 'علبة', 'صينية'],
      required: true,
    },
    unitEn: {
      type: String,
      enum: ['Kilo', 'Piece', 'Pack', 'Tray'],
      required: true,
    },
    reason: {
      type: String,
      trim: true,
    },
    reasonEn: {
      type: String,
      trim: true,
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
  },
  notesEn: {
    type: String,
    trim: true,
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
    trim: true,
  },
  requestedDeliveryDate: {
    type: Date,
  },
  approvedAt: { type: Date },
  transitStartedAt: { type: Date },
  deliveredAt: { type: Date },
  returns: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Return',
  }],
  statusHistory: [{
    status: {
      type: String,
      enum: ['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'],
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: {
      type: String,
      trim: true,
    },
    notesEn: {
      type: String,
      trim: true,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
});

// التحقق قبل الحفظ
orderSchema.pre('save', async function (next) {
  try {
    const Product = mongoose.model('Product');
    for (const item of this.items) {
      // جلب بيانات المنتج
      const product = await Product.findById(item.product);
      if (!product) {
        return next(new Error(this.options?.context?.isRtl ? `المنتج ${item.product} غير موجود` : `Product ${item.product} not found`));
      }

      // التحقق من تطابق الوحدات
      if (product.unit !== item.unit || product.unitEn !== item.unitEn) {
        return next(new Error(this.options?.context?.isRtl ? `الوحدة غير متطابقة للمنتج ${item.product}` : `Unit mismatch for product ${item.product}`));
      }

      // التحقق من الكمية بناءً على الوحدة
      if (item.unit === 'كيلو' || item.unitEn === 'Kilo') {
        if (item.quantity < 0.5 || item.quantity % 0.5 !== 0) {
          return next(new Error(this.options?.context?.isRtl ? `الكمية ${item.quantity} يجب أن تكون مضاعف 0.5 لوحدة الكيلو` : `Quantity ${item.quantity} must be a multiple of 0.5 for Kilo unit`));
        }
      } else if (['قطعة', 'علبة', 'صينية', 'Piece', 'Pack', 'Tray'].includes(item.unit)) {
        if (!Number.isInteger(item.quantity)) {
          return next(new Error(this.options?.context?.isRtl ? `الكمية ${item.quantity} يجب أن تكون عددًا صحيحًا لوحدة ${item.unit}` : `Quantity ${item.quantity} must be an integer for unit ${item.unitEn}`));
        }
      }
      item.quantity = Number(item.quantity.toFixed(1));

      // التحقق من كمية النقص
      if (item.shortageQuantity > 0) {
        if (item.shortageQuantity > item.quantity) {
          return next(new Error(this.options?.context?.isRtl ? `كمية النقص ${item.shortageQuantity} لا يمكن أن تتجاوز الكمية المطلوبة ${item.quantity}` : `Shortage quantity ${item.shortageQuantity} cannot exceed ordered quantity ${item.quantity}`));
        }
        if (item.unit === 'كيلو' || item.unitEn === 'Kilo') {
          if (item.shortageQuantity < 0.5 || item.shortageQuantity % 0.5 !== 0) {
            return next(new Error(this.options?.context?.isRtl ? `كمية النقص ${item.shortageQuantity} يجب أن تكون مضاعف 0.5 لوحدة الكيلو` : `Shortage quantity ${item.shortageQuantity} must be a multiple of 0.5 for Kilo unit`));
          }
        } else if (['قطعة', 'علبة', 'صينية', 'Piece', 'Pack', 'Tray'].includes(item.unit)) {
          if (!Number.isInteger(item.shortageQuantity)) {
            return next(new Error(this.options?.context?.isRtl ? `كمية النقص ${item.shortageQuantity} يجب أن تكون عددًا صحيحًا لوحدة ${item.unit}` : `Shortage quantity ${item.shortageQuantity} must be an integer for unit ${item.unitEn}`));
          }
        }
        item.shortageQuantity = Number(item.shortageQuantity.toFixed(1));
        item.receivedQuantity = Number((item.quantity - item.shortageQuantity).toFixed(1));
      }

      // تعبئة returnReasonEn
      if (item.returnReason) {
        item.returnReasonEn = returnReasonMapping[item.returnReason] || item.returnReason;
      } else {
        item.returnReasonEn = '';
      }

      // التحقق من تعيين الشيف
      if (item.assignedTo) {
        const chef = await mongoose.model('User').findById(item.assignedTo);
        if (chef && chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
          return next(new Error(this.options?.context?.isRtl ? `الشيف ${chef.name} لا يمكنه التعامل مع قسم ${product.department}` : `Chef ${chef.name} cannot handle department ${product.department}`));
        }
        item.status = item.status || 'assigned';
      }
    }

    // التحقق من النواقص
    for (const shortage of this.shortages || []) {
      const product = await Product.findById(shortage.product);
      if (!product) {
        return next(new Error(this.options?.context?.isRtl ? `المنتج ${shortage.product} غير موجود` : `Product ${shortage.product} not found`));
      }
      if (product.unit !== shortage.unit || product.unitEn !== shortage.unitEn) {
        return next(new Error(this.options?.context?.isRtl ? `الوحدة غير متطابقة للمنتج ${shortage.product}` : `Unit mismatch for product ${shortage.product}`));
      }
      if (shortage.unit === 'كيلو' || shortage.unitEn === 'Kilo') {
        if (shortage.quantity < 0.5 || shortage.quantity % 0.5 !== 0) {
          return next(new Error(this.options?.context?.isRtl ? `كمية النقص ${shortage.quantity} يجب أن تكون مضاعف 0.5 لوحدة الكيلو` : `Shortage quantity ${shortage.quantity} must be a multiple of 0.5 for Kilo unit`));
        }
      } else if (['قطعة', 'علبة', 'صينية', 'Piece', 'Pack', 'Tray'].includes(shortage.unit)) {
        if (!Number.isInteger(shortage.quantity)) {
          return next(new Error(this.options?.context?.isRtl ? `كمية النقص ${shortage.quantity} يجب أن تكون عددًا صحيحًا لوحدة ${shortage.unit}` : `Shortage quantity ${shortage.quantity} must be an integer for unit ${shortage.unitEn}`));
        }
      }
      shortage.quantity = Number(shortage.quantity.toFixed(1));
    }

    // حساب المجموع الكلي مع مراعاة الإرجاع
    const returns = await mongoose.model('Return').find({ _id: { $in: this.returns }, status: 'approved' });
    const returnAdjustments = returns.reduce((sum, ret) => sum + ret.totalReturnValue, 0);
    this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
    this.adjustedTotal = this.totalAmount - returnAdjustments;

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

    // إضافة سجل للإرجاع المعتمد
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

orderSchema.index({ orderNumber: 1, branch: 1 });
orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);