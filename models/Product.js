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
    required: false
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
    required: true, // الوحدة الآن مطلوبة
    enum: {
      values: ['كيلو', 'قطعة', 'علبة', 'صينية'],
      message: '{VALUE} ليست وحدة قياس صالحة'
    },
    trim: true
  },
  unitEn: {
    type: String,
    required: true, // الوحدة الإنجليزية مطلوبة
    enum: {
      values: ['Kilo', 'Piece', 'Pack', 'Tray'],
      message: '{VALUE} is not a valid English unit'
    },
    trim: true
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

// صيغ الوحدات في العربية بناءً على العدد
const unitForms = {
  'كيلو': {
    singular: 'كيلو',
    dual: 'كيلوين',
    pluralFew: 'كيلوات',
    pluralMany: 'كيلو'
  },
  'قطعة': {
    singular: 'قطعة',
    dual: 'قطعتين',
    pluralFew: 'قطع',
    pluralMany: 'قطعة'
  },
  'علبة': {
    singular: 'علبة',
    dual: 'علبتين',
    pluralFew: 'علب',
    pluralMany: 'علبة'
  },
  'صينية': {
    singular: 'صينية',
    dual: 'صينيتين',
    pluralFew: 'صواني',
    pluralMany: 'صينية'
  }
};

// قبل الحفظ، إملاء unitEn بناءً على unit
productSchema.pre('save', function(next) {
  if (this.unit) {
    this.unitEn = unitMapping[this.unit];
  }
  next();
});

// Virtual لعرض الاسم حسب اللغة
productSchema.virtual('displayName').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.name : (this.nameEn || this.name);
});

// Virtual لعرض الوحدة حسب اللغة
productSchema.virtual('displayUnit').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.unit : this.unitEn;
});

// Virtual لعرض الوحدة مع مراعاة الكمية
productSchema.virtual('displayUnitWithQuantity').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  const quantity = this.options?.context?.quantity ?? 1;

  if (!isRtl) {
    return this.unitEn; // الإنجليزية: دايمًا المفرد
  }

  const forms = unitForms[this.unit];
  if (!forms) {
    return this.unit; // لو الوحدة مش موجودة في unitForms
  }

  if (quantity === 1) {
    return forms.singular;
  } else if (quantity === 2) {
    return forms.dual;
  } else if (quantity >= 3 && quantity <= 10) {
    return forms.pluralFew;
  } else {
    return forms.pluralMany;
  }
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);