const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const orderSchema = new Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true
  },
  branch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true
  },
  items: [{
    _id: { type: Schema.Types.ObjectId, auto: true },
    product: {
      type: Schema.Types.ObjectId,
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
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
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
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: { type: Date },
  deliveredAt: { type: Date },
  statusHistory: [{
    status: String,
    changedBy: {
      type: Schema.Types.Mixed // Allow string or ObjectId
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
  console.log(`[${new Date().toISOString()}] Pre-save hook for order ${this._id}: Checking items and totalAmount`);
  for (const item of this.items) {
    if (item.assignedTo) {
      const product = await mongoose.model('Product').findById(item.product);
      const chef = await mongoose.model('User').findById(item.assignedTo);
      if (product && chef && chef.role === 'chef' && chef.department && product.department && chef.department.toString() !== product.department.toString()) {
        console.error(`[${new Date().toISOString()}] Validation error: Chef ${chef.name} cannot handle department ${product.department} for item ${item._id}`);
        return next(new Error(`الشيف ${chef.name} لا يمكنه التعامل مع قسم ${product.department}`));
      }
      item.status = 'assigned';
      console.log(`[${new Date().toISOString()}] Set item ${item._id} status to 'assigned' for chef ${chef?._id}`);
    }
  }
  this.totalAmount = this.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  console.log(`[${new Date().toISOString()}] Updated totalAmount for order ${this._id}: ${this.totalAmount}`);
  next();
});

orderSchema.pre('save', function(next) {
  if (this.isModified('items')) {
    const allCompleted = this.items.every(i => i.status === 'completed');
    if (allCompleted && this.status !== 'completed') {
      console.log(`[${new Date().toISOString()}] Automatically setting order ${this._id} status to 'completed' due to all items completed`);
      this.status = 'completed';
      this.statusHistory.push({
        status: 'completed',
        changedBy: 'system', // Now valid with Schema.Types.Mixed
        changedAt: new Date(),
      });
      console.log(`[${new Date().toISOString()}] Added statusHistory entry for order ${this._id}:`, {
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date().toISOString()
      });
    }
  }
  next();
});

module.exports = mongoose.model('Order', orderSchema);