const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  nameEn: {
    type: String,
    trim: true,
    required: true, // جعلناه مطلوب لمنع "undefined"
    default: 'Unknown Product' // قيمة افتراضية
  },
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  unit: {
    type: String,
    required: true, // جعلناه مطلوب لمنع "وحدة"
    enum: {
      values: ['كيلو', 'قطعة', 'علبة', 'صينية'],
      message: '{VALUE} ليست وحدة قياس صالحة'
    },
    trim: true,
    default: 'كيلو' // قيمة افتراضية
  },
  unitEn: {
    type: String,
    required: true, // جعلناه مطلوب
    enum: {
      values: ['Kilo', 'Piece', 'Pack', 'Tray'],
      message: '{VALUE} is not a valid English unit'
    },
    trim: true,
    default: 'Kilo' // قيمة افتراضية
  },
  description: {
    type: String,
    trim: true
  },
  image: {
    type: String,
    default: 'https://images.pexels.com/photos/1126359/pexels-photo-1126359.jpeg'
  },
  ingredients: [{
    type: String,
    trim: true
  }],
  preparationTime: {
    type: Number,
    default: 60
  },
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

// خريطة الوحدات
const unitMapping = {
  'كيلو': 'Kilo',
  'قطعة': 'Piece',
  'علبة': 'Pack',
  'صينية': 'Tray'
};

// قبل الحفظ، إملاء unitEn بناءً على unit
productSchema.pre('save', function(next) {
  if (this.unit) {
    this.unitEn = unitMapping[this.unit] || this.unit;
  } else {
    this.unit = 'كيلو';
    this.unitEn = 'Kilo';
  }
  next();
});

// Virtual لعرض الاسم حسب اللغة
productSchema.virtual('displayName').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.name || 'منتج غير معروف') : (this.nameEn || this.name || 'Unknown Product');
});

// Virtual لعرض الوحدة حسب اللغة
productSchema.virtual('displayUnit').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.unit || 'غير محدد') : (this.unitEn || this.unit || 'N/A');
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);