const mongoose = require('mongoose');

const productionAssignmentSchema = new mongoose.Schema({
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
  },
  factoryOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FactoryOrder',
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  chef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0.5, // الحد الأدنى للكمية
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed'],
    default: 'pending',
  },
  startedAt: {
    type: Date,
  },
  completedAt: {
    type: Date,
  },
  notes: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
});

// التحقق من الكمية بناءً على الوحدة قبل الحفظ
productionAssignmentSchema.pre('save', async function(next) {
  try {
    const product = await mongoose.model('Product').findById(this.product);
    if (!product) {
      return next(new Error(this.options?.context?.isRtl ? `المنتج ${this.product} غير موجود` : `Product ${this.product} not found`));
    }
    if (product.unit === 'كيلو' || product.unit === 'Kilo') {
      if (this.quantity < 0.5 || this.quantity % 0.5 !== 0) {
        return next(new Error(this.options?.context?.isRtl ? `الكمية ${this.quantity} يجب أن تكون مضاعف 0.5 لوحدة الكيلو` : `Quantity ${this.quantity} must be a multiple of 0.5 for Kilo unit`));
      }
    } else if (product.unit === 'قطعة' || product.unit === 'علبة' || product.unit === 'صينية') {
      if (!Number.isInteger(this.quantity)) {
        return next(new Error(this.options?.context?.isRtl ? `الكمية ${this.quantity} يجب أن تكون عددًا صحيحًا لوحدة ${product.unit}` : `Quantity ${this.quantity} must be an integer for unit ${product.unitEn}`));
      }
    }
    this.quantity = Number(this.quantity.toFixed(1));
    next();
  } catch (err) {
    next(err);
  }
});

productionAssignmentSchema.index({ order: 1, itemId: 1 }, { unique: true, sparse: true });
productionAssignmentSchema.index({ factoryOrder: 1, itemId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ProductionAssignment', productionAssignmentSchema);