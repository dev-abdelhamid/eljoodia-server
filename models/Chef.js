const mongoose = require('mongoose');

const chefSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  // For backward compatibility, keep department optional
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: false },
  departments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }],
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

// Pre-save hook for compatibility: if department is set and departments empty, set departments = [department]
chefSchema.pre('save', function(next) {
  if (this.department && (!this.departments || this.departments.length === 0)) {
    this.departments = [this.department];
  }
  next();
});

module.exports = mongoose.models.Chef || mongoose.model('Chef', chefSchema);