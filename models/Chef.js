const mongoose = require('mongoose');

const chefSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  departments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true }],
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Chef || mongoose.model('Chef', chefSchema);