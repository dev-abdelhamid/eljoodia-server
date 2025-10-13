const mongoose = require('mongoose');

const factoryProductionRequestSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['branch', 'production'],
    required: [true, 'نوع الطلب مطلوب'],
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: function () { return this.type === 'branch'; },
  },
  status: {
    type: String,
    enum: ['pending', 'assigned', 'in_progress', 'completed', 'delivered', 'rejected'],
    default: 'pending',
  },
  items: [{
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'معرف المنتج مطلوب'],
    },
    quantity: {
      type: Number,
      required: [true, 'الكمية مطلوبة'],
      min: [1, 'الكمية يجب أن تكون أكبر من 0'],
    },
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المستخدم مطلوب'],
  },
  assignedChef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  deliveredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  notes: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

factoryProductionRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('FactoryProductionRequest', factoryProductionRequestSchema);