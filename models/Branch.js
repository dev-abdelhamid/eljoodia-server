const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name: {
    ar: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
  },
  code: { type: String, required: true, unique: true, trim: true },
  address: {
    ar: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
  },
  city: {
    ar: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
  },
  phone: { type: String, trim: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Branch', branchSchema);