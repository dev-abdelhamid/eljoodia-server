const mongoose = require('mongoose');

const chefSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    unique: true 
  },
  // تم تحويله إلى مصفوفة لدعم أكثر من قسم
  department: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Department', 
    required: true 
  }],
  status: { 
    type: String, 
    enum: ['active', 'inactive'], 
    default: 'active' 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
}, {
  timestamps: true
});

module.exports = mongoose.models.Chef || mongoose.model('Chef', chefSchema);