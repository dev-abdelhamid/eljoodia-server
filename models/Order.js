const mongoose = require('mongoose');
const { isValidObjectId } = mongoose;

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
  notes: { type: String, trim: true, required: false },
  notesEn: { type: String, trim: true, required: false },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
    trim: true,
  },
  requestedDeliveryDate: { type: Date },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  deliveredAt: { type: Date },
  transitStartedAt: { type: Date },
  returns: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Return',
  }],
  statusHistory: [{
    status: String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true },
    notesEn: { type: String, trim: true },
    changedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

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

// Virtuals
orderSchema.virtual('items.$*.displayReturnReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.returnReason || 'غير محدد') : (this.returnReasonEn || this.returnReason || 'N/A');
});

orderSchema.virtual('displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

orderSchema.virtual('statusHistory.$*.displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

// === التحقق من تعيين الشيفات + دعم Array من الأقسام ===
orderSchema.pre('save', async function(next) {
  try {
    const isRtl = this.options?.context?.isRtl ?? true;

    // جلب المنتجات والشيفات مرة واحدة
    const productIds = this.items.filter(i => i.assignedTo).map(i => i.product);
    const chefIds = [...new Set(this.items.filter(i => i.assignedTo).map(i => i.assignedTo))];

    if (productIds.length === 0 || chefIds.length === 0) return next();

    const [products, chefs] = await Promise.all([
      mongoose.model('Product').find({ _id: { $in: productIds } })
        .populate('department', '_id')
        .lean(),
      mongoose.model('User').find({ _id: { $in: chefIds }, role: 'chef' })
        .populate('department', '_id') // جلب الأقسام كـ Array
        .lean(),
    ]);

    const productMap = new Map(products.map(p => [p._id.toString(), p]));
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));

    for (const item of this.items) {
      if (!item.assignedTo) continue;

      const product = productMap.get(item.product.toString());
      const chef = chefMap.get(item.assignedTo.toString());

      if (!product || !product.department) {
        return next(new Error(isRtl ? 'المنتج غير مرتبط بقسم' : 'Product not linked to a department'));
      }

      if (!chef) {
        return next(new Error(isRtl ? 'الشيف غير موجود' : 'Chef not found'));
      }

      const chefDeptIds = Array.isArray(chef.department)
        ? chef.department.map(d => d._id.toString())
        : chef.department ? [chef.department._id.toString()] : [];

      const productDeptId = product.department._id.toString();

      if (!chefDeptIds.includes(productDeptId)) {
        const deptName = isRtl
          ? product.department.name || 'غير معروف'
          : product.department.nameEn || product.department.name || 'Unknown';
        return next(new Error(
          isRtl
            ? `الشيف ${chef.name || chef.username} لا يملك صلاحية قسم "${deptName}"`
            : `Chef ${chef.name || chef.username} is not authorized for department "${deptName}"`
        ));
      }

      // تحديث الحالة
      if (!item.status || item.status === 'pending') {
        item.status = 'assigned';
      }
    }

    // === حساب المبلغ المعدل بناءً على الإرجاعات المعتمدة ===
    if (this.returns?.length > 0) {
      const returns = await mongoose.model('Return').find({
        _id: { $in: this.returns },
        status: 'approved'
      }).lean();

      const returnAdjustments = returns.reduce((sum, ret) => sum + (ret.totalReturnValue || 0), 0);
      this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
      this.adjustedTotal = this.totalAmount - returnAdjustments;
    } else {
      this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
      this.adjustedTotal = this.totalAmount;
    }

    // === تحديث حالة الطلب بناءً على حالة العناصر ===
    if (this.isModified('items')) {
      const allAssigned = this.items.every(i => i.status === 'assigned' || i.status === 'in_progress' || i.status === 'completed');
      const allCompleted = this.items.every(i => i.status === 'completed');

      if (allAssigned && this.status === 'approved') {
        this.status = 'in_production';
        this.statusHistory.push({
          status: 'in_production',
          changedBy: this.approvedBy || this.createdBy,
          changedAt: new Date(),
        });
      }

      if (allCompleted && !['completed', 'in_transit', 'delivered'].includes(this.status)) {
        this.status = 'completed';
        this.statusHistory.push({
          status: 'completed',
          changedBy: this.approvedBy || this.createdBy,
          changedAt: new Date(),
        });
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Indexes
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ branch: 1 });
orderSchema.index({ 'items.product': 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });

// Virtuals
orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);