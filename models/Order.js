const mongoose = require('mongoose');

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
  for (const item of this.items) {
    if (item.assignedTo) {
      const product = await mongoose.model('Product').findById(item.product);
      const chef = await mongoose.model('User').findById(item.assignedTo);
      if (product && chef && chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
        return next(new Error(`الشيف ${chef.name} لا يمكنه التعامل مع قسم ${product.department}`));
      }
      item.status = 'assigned';
    }
  }
  this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  next();
});

orderSchema.pre('save', function(next) {
  if (this.isModified('items')) {
    const allCompleted = this.items.every(i => i.status === 'completed');
    if (allCompleted && this.status !== 'completed') {
      this.status = 'completed';
      this.statusHistory.push({
        status: 'completed',
        changedBy: this.createdBy, // or use a middleware to set changedBy
        changedAt: new Date(),
      });
    }
  }
  next();
});

module.exports = mongoose.model('Order', orderSchema);