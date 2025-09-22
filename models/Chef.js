const mongoose = require('mongoose');

const chefSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

// Virtual to return name based on language
chefSchema.virtual('displayName', {
  ref: 'User',
  localField: 'user',
  foreignField: '_id',
  justOne: true,
}).get(function (user) {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? user?.name : user?.nameEn || user?.name;
});

chefSchema.set('toJSON', { virtuals: true });
chefSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Chef || mongoose.model('Chef', chefSchema);