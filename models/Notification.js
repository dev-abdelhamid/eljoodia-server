const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const notificationSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  branch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: false
  },
  type: {
    type: String,
    required: true,
    enum: [
      'order_created',
      'order_approved',
      'order_status_updated',
      'task_assigned',
      'task_completed',
      'order_completed',
      'order_in_transit',
      'order_delivered',
      'return_created',
      'return_status_updated',
      'missing_assignments'
    ]
  },
  message: {
    type: String,
    required: true
  },
  data: {
    type: Schema.Types.Mixed,
    default: {}
  },
  read: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  sound: {
    type: String,
    default: '/notification.mp3'
  },
  vibrate: {
    type: [Number],
    default: [200, 100, 200]
  }
}, {
  timestamps: true
});

// Indexes for performance
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ branch: 1, createdAt: -1 });

notificationSchema.pre('save', function(next) {
  console.log(`[${new Date().toISOString()}] Saving notification:`, {
    user: this.user.toString(),
    branch: this.branch?.toString() || 'None',
    type: this.type,
    message: this.message
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);