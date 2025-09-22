const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
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
    name: String,
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  unit: {
    type: String,
    required: true,
    enum: ['كيلو', 'قطعة', 'علبة', 'صينية']
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

module.exports = mongoose.model('Product', productSchema);