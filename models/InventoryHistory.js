const mongoose = require('mongoose');

const inventoryHistorySchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'معرف المنتج مطلوب'],
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'معرف الفرع مطلوب'],
  },
  action: {
    type: String,
    required: [true, 'نوع الإجراء مطلوب'],
    enum: ['restock', 'return_pending', 'return_approved', 'return_rejected', 'adjustment'],
  },
  quantity: {
    type: Number,
    required: [true, 'الكمية مطلوبة'],
  },
  reference: {
    type: String,
    trim: true,
  },
  referenceType: {
    type: String,
    enum: ['order', 'return', 'adjustment'],
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المستخدم مطلوب'],
  },
  notes: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);