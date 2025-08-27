const mongoose = require('mongoose');



const saleSchema = new mongoose.Schema({
  saleNumber: { type: String, required: true, unique: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  items: [
    {
      product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      quantity: { type: Number, required: true, min: 1 },
      unitPrice: { type: Number, required: true, min: 0 },
    },
  ],
  totalAmount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'completed' },
  paymentMethod: { type: String, enum: ['cash', 'credit', 'other'], default: 'cash' },
  customerName: { type: String, trim: true },
  customerPhone: { type: String, trim: true },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

module.exports = mongoose.model('Sale', saleSchema);