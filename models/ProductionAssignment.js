const mongoose = require('mongoose');

const productionAssignmentSchema = new mongoose.Schema({
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  chef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chef',
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
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

module.exports = mongoose.model('ProductionAssignment', productionAssignmentSchema);