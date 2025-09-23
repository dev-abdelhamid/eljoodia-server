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
    required: false,
    enum: {
      values: ['كيلو', 'قطعة', 'علبة', 'صينية', ''],
      message: '{VALUE} is not a valid unit'
    },
    trim: true
  },
  unitEn: {
    type: String,
    required: false,
    enum: {
      values: ['Kilo', 'Piece', 'Pack', 'Tray', ''],
      message: '{VALUE} is not a valid unitEn'
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

// Unit mapping for validation
const unitMapping = {
  'كيلو': 'Kilo',
  'قطعة': 'Piece',
  'علبة': 'Pack',
  'صينية': 'Tray',
  '': ''
};

// Pre-save hook to ensure unit and unitEn consistency
productSchema.pre('save', function(next) {
  if (this.unit && this.unitEn) {
    if (unitMapping[this.unit] !== this.unitEn) {
      return next(new Error('Unit and English unit do not match'));
    }
  } else if (this.unit && !this.unitEn) {
    this.unitEn = unitMapping[this.unit];
  } else if (!this.unit && this.unitEn) {
    this.unit = Object.keys(unitMapping).find(key => unitMapping[key] === this.unitEn) || '';
  }
  next();
});

// Virtual to return name based on language
productSchema.virtual('displayName').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.name : (this.nameEn || this.name);
});

// Virtual to return unit based on language
productSchema.virtual('displayUnit').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.unit || 'غير محدد') : (this.unitEn || this.unit || 'N/A');
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);