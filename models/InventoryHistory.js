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
    enum: {
      values: ['delivery', 'return_pending', 'return_rejected', 'return_approved', 'sale', 'sale_cancelled', 'sale_deleted', 'restock', 'adjustment', 'settings_adjustment'],
      message: 'الإجراء غير صالح'
    },
    required: [true, 'الإجراء مطلوب'],
  },
  quantity: {
    type: Number,
    required: [true, 'الكمية مطلوبة'],
  },
  reference: {
    type: String,
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المستخدم مطلوب'],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  notes: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// إضافة فهرس لتحسين الأداء
inventoryHistorySchema.index({ product: 1, branch: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);