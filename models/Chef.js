const mongoose = require('mongoose');

const chefSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: false }, // مش إجباري
  departments: [{ // دعم أكثر من قسم
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department'
  }],
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

// Virtual للأقسام الفعالة
chefSchema.virtual('effectiveDepartments').get(function() {
  const depts = this.departments || [];
  const deptIds = depts.map(d => d.toString());
  if (this.department && !deptIds.includes(this.department.toString())) {
    deptIds.push(this.department.toString());
  }
  return deptIds;
});

module.exports = mongoose.models.Chef || mongoose.model('Chef', chefSchema);