const mongoose = require('mongoose');

const factoryOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: [true, 'رقم الطلب مطلوب'], unique: true, trim: true },
  items: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: [true, 'المنتج مطلوب'] },
    quantity: { type: Number, required: [true, 'الكمية مطلوبة'], min: [1, 'الكمية يجب أن تكون أكبر من 0'] },
    status: { type: String, enum: ['pending', 'assigned', 'in_progress', 'completed'], default: 'pending' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    startedAt: Date,
    completedAt: Date,
  }],
  status: { type: String, enum: ['pending', 'in_production', 'completed', 'cancelled'], default: 'pending' },
  notes: String,
  notesEn: String,
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  statusHistory: [{
    status: String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: Date,
    notes: String,
    notesEn: String,
  }],
}, { timestamps: true });

factoryOrderSchema.pre('save', function (next) {
  next();
});

module.exports = mongoose.model('FactoryOrder', factoryOrderSchema);