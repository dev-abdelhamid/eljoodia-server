const mongoose = require('mongoose');

const inventoryHistorySchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'معرف المنتج مطلوب' : 'Product ID is required'],
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'معرف الفرع مطلوب' : 'Branch ID is required'],
  },
  action: {
    type: String,
    enum: {
      values: ['delivery', 'return_pending', 'return_rejected', 'return_approved', 'sale', 'sale_cancelled', 'sale_deleted', 'restock', 'adjustment', 'settings_adjustment'],
      message: (value, { req }) => req.query.lang === 'ar' ? 'الإجراء غير صالح' : 'Invalid action',
    },
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'الإجراء مطلوب' : 'Action is required'],
  },
  quantity: {
    type: Number,
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'الكمية مطلوبة' : 'Quantity is required'],
  },
  reference: {
    type: String,
    trim: true,
  },
  referenceType: {
    type: String,
    enum: ['order', 'return', 'sale', 'adjustment'],
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceType',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, (value, { req }) => req.query.lang === 'ar' ? 'معرف المستخدم مطلوب' : 'User ID is required'],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  notes: {
    type: String,
    trim: true,
  },
  isDamaged: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

inventoryHistorySchema.index({ product: 1, branch: 1, createdAt: -1 });
inventoryHistorySchema.index({ referenceType: 1, referenceId: 1 });
inventoryHistorySchema.index({ branch: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);