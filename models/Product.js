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
    required: false // English name is optional
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
    required: false, // Unit is optional
    enum: {
      values: ['كيلو', 'قطعة', 'علبة', 'صينية', ''], // Allow empty string for optional
      message: '{VALUE} is not a valid unit'
    },
    trim: true
  },
  unitEn: {
    type: String,
    required: false, // English unit is optional
    enum: {
      values: ['Kilo', 'Piece', 'Pack', 'Tray', ''], // Allow empty string for optional
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
    type: Number, // in minutes
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

// Ensure virtuals are included in toJSON and toObject
productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);