const mongoose = require('mongoose');

const ProductionAssignmentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true },
  quantity: { type: Number, required: true, min: 1 },
  itemId: { type: mongoose.Schema.Types.ObjectId, required: true }, // Corresponds to order.items._id
  status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
  startedAt: { type: Date },
  completedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ProductionAssignment', ProductionAssignmentSchema);