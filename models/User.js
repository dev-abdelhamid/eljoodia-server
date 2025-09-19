const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'اسم المستخدم مطلوب'],
    trim: true,
    maxlength: [100, 'اسم المستخدم لا يمكن أن يتجاوز 100 حرف'],
  },
  email: {
    type: String,
    required: [true, 'البريد الإلكتروني مطلوب'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'البريد الإلكتروني غير صالح'],
  },
  password: {
    type: String,
    required: [true, 'كلمة المرور مطلوبة'],
    minlength: [6, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل'],
  },
  role: {
    type: String,
    enum: {
      values: ['admin', 'production', 'branch', 'chef'],
      message: 'الدور يجب أن يكون إما admin، production، branch، أو chef',
    },
    required: [true, 'الدور مطلوب'],
  },
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// فهارس لتحسين أداء الاستعلامات
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ department: 1 });

module.exports = mongoose.model('User', userSchema);