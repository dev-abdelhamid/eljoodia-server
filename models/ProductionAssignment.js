const mongoose = require('mongoose');

const productionAssignmentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  chef: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quantity: { type: Number, required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order.items', required: true }, // ربط مع عناصر الطلب
  status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
  startedAt: Date,
  completedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('ProductionAssignment', productionAssignmentSchema);