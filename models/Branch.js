const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nameEn: { type: String, trim: true, required: false }, // English name, optional
  code: { type: String, required: true, unique: true, trim: true },
  address: { type: String, required: true, trim: true },
  addressEn: { type: String, trim: true, required: false }, // English address, optional
  city: { type: String, required: true, trim: true },
  cityEn: { type: String, trim: true, required: false }, // English city, optional
  phone: { type: String, trim: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Virtuals to return name, address, and city based on language
branchSchema.virtual('displayName').get(function() {
  return this.nameEn || this.name; // Fallback to Arabic name if nameEn is not set
});

branchSchema.virtual('displayAddress').get(function() {
  return this.addressEn || this.address; // Fallback to Arabic address if addressEn is not set
});

branchSchema.virtual('displayCity').get(function() {
  return this.cityEn || this.city; // Fallback to Arabic city if cityEn is not set
});

// Ensure virtuals are included in toJSON and toObject
branchSchema.set('toJSON', { virtuals: true });
branchSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Branch || mongoose.model('Branch', branchSchema);