// models/Product.js
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nameEn: { type: String, trim: true },
  code: { type: String, required: true, unique: true, trim: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  price: { type: Number, required: true, min: 0 },
  unit: {
    type: String,
    enum: ['كيلو', 'قطعة', 'علبة', 'صينية', ''],
    default: '',
    trim: true
  },
  unitEn: {
    type: String,
    enum: ['Kilo', 'Piece', 'Pack', 'Tray', ''],
    default: '',
    trim: true
  },
  description: { type: String, trim: true },
  image: {
    type: String,
    default: 'https://images.pexels.com/photos/1126359/pexels-photo-1126359.jpeg'
  },
  ingredients: [{ type: String, trim: true }],
  preparationTime: { type: Number, default: 60 },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// خريطة الوحدات
const unitMapping = { 'كيلو': 'Kilo', 'قطعة': 'Piece', 'علبة': 'Pack', 'صينية': 'Tray', '': '' };

// تحديث unitEn تلقائيًا
productSchema.pre('save', function(next) {
  if (this.unit) {
    this.unitEn = unitMapping[this.unit] || '';
  } else {
    this.unit = '';
    this.unitEn = '';
  }
  next();
});

// Virtuals
productSchema.virtual('displayName').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.name : (this.nameEn || this.name);
});

productSchema.virtual('displayUnit').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.unit || 'غير محدد') : (this.unitEn || this.unit || 'N/A');
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);