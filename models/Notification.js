const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const notificationSchema = new mongoose.Schema(
  {
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
        'order_created',
        'order_status_updated',
        'item_status_updated',
        'order_completed',
        'order_delivered',
        'return_created',
        'return_status_updated',
        'task_assigned',
        'task_completed',
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
      index: { expires: '30d' },
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ 'data.eventId': 1 }, { unique: true });

notificationSchema.pre('save', function (next) {
  console.log(`[${new Date().toISOString()}] Pre-save hook for notification:`, {
    user: this.user,
    type: this.type,
    message: this.message,
    data: this.data,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);