const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  nameEn: {
    type: String,
    trim: true,
    required: false // English name is optional
  },
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  chef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Chef is optional
  },
  chefs: [{ // دعم أكثر من شيف
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Virtual to return name based on language
departmentSchema.virtual('displayName').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.name : (this.nameEn || this.name);
});

// Virtual للشيفات الفعالة (chef + chefs)
departmentSchema.virtual('effectiveChefs').get(function() {
  const chefs = this.chefs || [];
  const chefIds = chefs.map(c => c.toString());
  if (this.chef && !chefIds.includes(this.chef.toString())) {
    chefIds.push(this.chef.toString());
  }
  return chefIds;
});

// Ensure virtuals are included in toJSON and toObject
departmentSchema.set('toJSON', { virtuals: true });
departmentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Department || mongoose.model('Department', departmentSchema);