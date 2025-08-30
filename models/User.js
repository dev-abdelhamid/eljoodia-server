const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    lowercase: true,
    minlength: [3, 'Username must be at least 3 characters long'],
    maxlength: [50, 'Username cannot exceed 50 characters'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters long'],
    validate: {
      validator: function (value) {
        // Enforce password complexity: at least one uppercase, one lowercase, one number
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(value);
      },
      message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
    },
  },
  role: {
    type: String,
    required: [true, 'Role is required'],
    enum: {
      values: ['admin', 'branch', 'chef', 'production'],
      message: 'Invalid role. Must be one of: admin, branch, chef, production',
    },
  },
  name: {
    ar: { type: String, required: [true, 'Arabic name is required'], trim: true, minlength: [2, 'Arabic name must be at least 2 characters'] },
    en: { type: String, required: [true, 'English name is required'], trim: true, minlength: [2, 'English name must be at least 2 characters'] },
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    sparse: true,
    unique: true,
    validate: {
      validator: function (value) {
        if (!value) return true; // Allow null/undefined since email is optional
        return /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(value);
      },
      message: 'Invalid email format',
    },
  },
  phone: {
    type: String,
    trim: true,
    validate: {
      validator: function (value) {
        if (!value) return true; // Allow null/undefined since phone is optional
        return /^\+?\d{10,15}$/.test(value);
      },
      message: 'Invalid phone number format',
    },
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: function () {
      return this.role === 'branch';
    },
  },
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: function () {
      return this.role === 'chef';
    },
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastLogin: {
    type: Date,
  },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      ret.id = ret._id; // Ensure `id` is included in responses for frontend compatibility
      delete ret._id;
      delete ret.__v;
      delete ret.password; // Never expose password in responses
      return ret;
    },
  },
});

// Indexes for performance
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1 });

// Password hashing middleware
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12); // Increased salt rounds for better security
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Password comparison method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Custom error handler for validation and duplicate key errors
userSchema.post('save', function (error, doc, next) {
  const lang = this.lang || 'en'; // Assume lang is set in the request context
  if (error.name === 'MongoServerError' && error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    const message = lang === 'ar'
      ? `حقل ${field} مستخدم بالفعل`
      : `Field ${field} is already in use`;
    next(new Error(message));
  } else if (error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((err) => {
      return lang === 'ar' ? translateError(err.message, 'ar') : err.message;
    });
    next(new Error(messages.join(', ')));
  } else {
    next(error);
  }
});

// Helper function to translate validation error messages
function translateError(message, lang) {
  const translations = {
    en: {
      'Username is required': 'Username is required',
      'Password is required': 'Password is required',
      'Role is required': 'Role is required',
      'Arabic name is required': 'Arabic name is required',
      'English name is required': 'English name is required',
      'Invalid role. Must be one of: admin, branch, chef, production': 'Invalid role. Must be one of: admin, branch, chef, production',
      'Invalid email format': 'Invalid email format',
      'Invalid phone number format': 'Invalid phone number format',
      'Username must be at least 3 characters long': 'Username must be at least 3 characters long',
      'Password must be at least 8 characters long': 'Password must be at least 8 characters long',
      'Password must contain at least one uppercase letter, one lowercase letter, and one number': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      'Arabic name must be at least 2 characters': 'Arabic name must be at least 2 characters',
      'English name must be at least 2 characters': 'English name must be at least 2 characters',
    },
    ar: {
      'Username is required': 'اسم المستخدم مطلوب',
      'Password is required': 'كلمة المرور مطلوبة',
      'Role is required': 'الدور مطلوب',
      'Arabic name is required': 'الاسم بالعربية مطلوب',
      'English name is required': 'الاسم بالإنجليزية مطلوب',
      'Invalid role. Must be one of: admin, branch, chef, production': 'دور غير صالح. يجب أن يكون أحد الآتي: أدمن، فرع، شيف، إنتاج',
      'Invalid email format': 'تنسيق البريد الإلكتروني غير صالح',
      'Invalid phone number format': 'تنسيق رقم الهاتف غير صالح',
      'Username must be at least 3 characters long': 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل',
      'Password must be at least 8 characters long': 'كلمة المرور يجب أن تكون 8 أحرف على الأقل',
      'Password must contain at least one uppercase letter, one lowercase letter, and one number': 'كلمة المرور يجب أن تحتوي على حرف كبير، حرف صغير، ورقم على الأقل',
      'Arabic name must be at least 2 characters': 'الاسم بالعربية يجب أن يكون حرفين على الأقل',
      'English name must be at least 2 characters': 'الاسم بالإنجليزية يجب أن يكون حرفين على الأقل',
    },
  };
  return translations[lang][message] || message;
}

module.exports = mongoose.models.User || mongoose.model('User', userSchema);