const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const notificationSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: uuidv4,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: [
      'orderCreated', 'orderConfirmed', 'taskAssigned', 'itemStatusUpdated', 'orderStatusUpdated',
      'orderCompleted', 'orderShipped', 'orderDelivered', 'returnStatusUpdated', 'missingAssignments'
    ],  // كل الأنواع من Frontend
  },
  message: {
    type: String,
    required: true,
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true,  // required للـ eventId
    default: {},
  },
  read: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: '30d',  // TTL: احذف بعد 30 يوم (best practice 2025)
  },
}, {
  timestamps: true,
});

// Unique compound index لمنع duplicates (Mongoose 8.x best practice)
notificationSchema.index({ 'data.eventId': 1, user: 1 }, { unique: true });

notificationSchema.pre('save', function(next) {
  console.log(`[${new Date().toISOString()}] Pre-save hook for notification:`, {
    user: this.user,
    type: this.type,
    eventId: this.data.eventId,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);