const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      required: true,
    },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
    },
    items: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Product',
          required: true,
        },
        department: {
          // Added to store department reference
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Department',
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
        returnedQuantity: {
          type: Number,
          default: 0,
          min: 0,
        },
        returnReason: {
          type: String,
          trim: true,
        },
      },
    ],
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
    transitStartedAt: {
      type: Date,
    },
    statusHistory: [
      {
        status: String,
        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        notes: String,
        changedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
    strictPopulate: false, // Allow populating paths not defined in schema
  }
);

// Middleware to validate chef assignments and department matching
orderSchema.pre('save', async function (next) {
  try {
    for (const item of this.items) {
      if (item.assignedTo) {
        const product = await mongoose.model('Product').findById(item.product);
        const chef = await mongoose.model('User').findById(item.assignedTo);
        if (product && chef && chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
          return next(new Error(`الشيف ${chef.name} لا يمكنه التعامل مع قسم ${product.department}`));
        }
        item.status = item.status || 'assigned';
        // Store department in item
        if (product && product.department) {
          item.department = product.department;
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
    next(err);
  }
});

// Middleware to update order status based on item statuses
orderSchema.pre('save', async function (next) {
  try {
    if (this.isModified('items')) {
      const allCompleted = this.items.every((i) => i.status === 'completed');
      if (allCompleted && !['completed', 'in_transit', 'delivered'].includes(this.status)) {
        this.status = 'completed';
        this.statusHistory.push({
          status: 'completed',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
        });
      } else if (this.status === 'approved' && this.items.some((i) => i.status === 'in_progress')) {
        this.status = 'in_production';
        this.statusHistory.push({
          status: 'in_production',
          changedBy: this.approvedBy || this.createdBy || 'system',
          changedAt: new Date(),
        });
      }
      // Ensure items array is marked as modified
      this.markModified('items');
    }
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Order', orderSchema);