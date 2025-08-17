const mongoose = require('mongoose');

// تحديد المخطط
const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true
  },
  items: [{
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    price: {
      type: Number,
      required: true,
      min: 0
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'in_progress', 'completed'],
      default: 'pending'
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    startedAt: { type: Date },
    completedAt: { type: Date }
  }],
  totalAmount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'],
    default: 'pending'
  },
  notes: { type: String, trim: true },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  requestedDeliveryDate: {
    type: Date,
    required: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: { type: Date },
  deliveredAt: { type: Date },
  statusHistory: [{
    status: String,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    notes: String,
    changedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

orderSchema.pre('save', async function(next) {
  const Product = mongoose.model('Product');
  const User = mongoose.model('User');
  const ProductionAssignment = mongoose.model('ProductionAssignment');

  for (const item of this.items) {
    const product = await Product.findById(item.product);
    if (!product) {
      return next(new Error(`المنتج ${item.product} غير موجود`));
    }
    item.department = product.department;

    if (item.assignedTo) {
      const chef = await User.findById(item.assignedTo);
      if (!chef || chef.role !== 'chef' || !chef.department || chef.department.toString() !== product.department.toString()) {
        return next(new Error(`الشيف ${chef?.name || item.assignedTo} لا يمكنه التعامل مع قسم ${product.department}`));
      }
      item.status = 'assigned';

      const assignmentExists = await ProductionAssignment.findOne({
        order: this._id,
        itemId: item._id,
        product: item.product
      });
      if (!assignmentExists) {
        const chefProfile = await mongoose.model('Chef').findOne({ user: item.assignedTo });
        if (chefProfile) {
          await ProductionAssignment.create({
            order: this._id,
            product: item.product,
            chef: chefProfile._id,
            quantity: item.quantity,
            itemId: item._id,
            status: 'pending'
          });
        }
      }
    }
  }
  this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  next();
});

// التحقق من وجود النموذج قبل تجميعه
module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);