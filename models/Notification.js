const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const notificationSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: uuidv4,
  },
  user: {
    type: String,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: [
      'new_order_from_branch',
      'branch_confirmed_receipt',
      'new_order_for_production',
      'order_completed_by_chefs',
      'order_approved_for_branch',
      'order_in_transit_to_branch',
      'new_production_assigned_to_chef',
      'order_status_updated',
      'task_assigned',
      'order_completed',
      'order_delivered',
      'return_status_updated',
    ],
  },
  message: {
    type: String,
    required: true,
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  read: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: { expires: '30d' }, // حذف الإشعارات بعد 30 يوم
  },
  sound: {
    type: String,
    default: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
  },
  vibrate: {
    type: [Number],
    default: [200, 100, 200],
  },
}, {
  timestamps: true,
});

notificationSchema.pre('save', function(next) {
  console.log(`[${new Date().toISOString()}] Pre-save hook for notification:`, {
    user: this.user,
    type: this.type,
    message: this.message,
    data: this.data,
    sound: this.sound,
    vibrate: this.vibrate,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);