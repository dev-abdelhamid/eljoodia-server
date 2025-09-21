const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nameEn: { type: String, trim: true, required: false }, // English name, optional
  code: { type: String, required: true, unique: true, trim: true },
  address: { type: String, required: true, trim: true },
  city: { type: String, required: true, trim: true },
  phone: { type: String, trim: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Virtual to return name based on language
branchSchema.virtual('displayName').get(function() {
  return this.nameEn || this.name; // Fallback to Arabic name if nameEn is not set
});

// Ensure virtuals are included in toJSON and toObject
branchSchema.set('toJSON', { virtuals: true });
branchSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Branch || mongoose.model('Branch', branchSchema);