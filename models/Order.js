const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const orderSchema = new Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true,
  },
  branch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  items: [{
    _id: { type: Schema.Types.ObjectId, auto: true },
    product: {
      type: Schema.Types.ObjectId,
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
      type: Schema.Types.ObjectId,
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
      trim: true,
    },
  }],
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'],
    default: 'pending',
  },
  notes: { type: String, trim: true },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  },
  requestedDeliveryDate: {
    type: Date,
    required: false,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: { type: Date },
  deliveredAt: { type: Date },
  transitStartedAt: {
    type: Date,
  },
  statusHistory: [{
    status: String,
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: String,
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
});

// Indexes for performance
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ branch: 1, createdAt: -1 });
orderSchema.index({ 'items.product': 1 });

// Middleware to validate chef assignments and auto-assign single chef
orderSchema.pre('save', async function(next) {
  try {
    for (const item of this.items) {
      if (item.assignedTo) {
        const product = await mongoose.model('Product').findById(item.product).select('department').lean();
        const chef = await mongoose.model('User').findById(item.assignedTo).select('role department').lean();
        if (!product || !chef) {
          return next(new Error(`Product or chef not found for item ${item._id}`));
        }
        if (chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
          return next(new Error(`Chef ${chef._id} cannot be assigned to department ${product.department}`));
        }
        item.status = item.status || 'assigned';
      } else if (item.status === 'pending') {
        // Auto-assign if only one chef is available in the product's department
        const product = await mongoose.model('Product').findById(item.product).select('department').lean();
        if (product && product.department) {
          const chefs = await mongoose.model('Chef').find({ department: product.department, status: 'active' })
            .populate('user', 'role isActive')
            .lean();
          const activeChefs = chefs.filter(chef => chef.user?.role === 'chef' && chef.user?.isActive);
          if (activeChefs.length === 1) {
            item.assignedTo = activeChefs[0].user._id;
            item.status = 'assigned';
            console.log(`[${new Date().toISOString()}] Auto-assigned chef ${activeChefs[0].user._id} to item ${item._id} in department ${product.department}`);
          }
        }
      }
    }
    // Update totalAmount considering returned quantities
    this.totalAmount = this.items.reduce((sum, item) => {
      const effectiveQuantity = item.quantity - (item.returnedQuantity || 0);
      return sum + effectiveQuantity * item.price;
    }, 0);
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in order pre-save:`, err);
    next(err);
  }
});

// Middleware to update order status based on item statuses
orderSchema.pre('save', async function(next) {
  try {
    if (this.isModified('items')) {
      const allCompleted = this.items.every(i => i.status === 'completed');
      const hasInProgress = this.items.some(i => i.status === 'in_progress');
      const allAssigned = this.items.every(i => i.status === 'assigned' || i.status === 'in_progress' || i.status === 'completed');

      if (allCompleted && this.status !== 'completed' && this.status !== 'in_transit' && this.status !== 'delivered') {
        this.status = 'completed';
        this.statusHistory.push({
          status: 'completed',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
        });
      } else if (hasInProgress && this.status === 'approved') {
        this.status = 'in_production';
        this.statusHistory.push({
          status: 'in_production',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
        });
      } else if (allAssigned && this.status === 'approved') {
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
    console.error(`[${new Date().toISOString()}] Error in order status pre-save:`, err);
    next(err);
  }
});

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);