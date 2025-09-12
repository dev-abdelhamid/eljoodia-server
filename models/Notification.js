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
      'orderCreated',
      'itemCompleted',
      'orderConfirmed',
      'taskAssigned',
      'itemStatusUpdated',
      'orderStatusUpdated',
      'orderCompleted',
      'orderShipped',
      'orderDelivered',
      'returnStatusUpdated',
      'missingAssignments',
      'orderApproved',
      'orderInTransit',
      'branchConfirmedReceipt',
      'taskStarted',
      'taskCompleted',
    ],
  },
  message: {
    type: String,
    required: true,
  },
  messageKey: {
    type: String,
    required: true, // لتخزين مفتاح الترجمة مثل notifications.order_created
  },
  params: {
    type: mongoose.Schema.Types.Mixed, // لتخزين البارامترات مثل orderNumber, branchName
    default: {},
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    default: {},
  },
  read: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: '30d', // حذف بعد 30 يوم
  },
}, {
  timestamps: true,
});

// فهرس لمنع التكرار بناءً على eventId و user
notificationSchema.index({ 'data.eventId': 1, user: 1 }, { unique: true });

notificationSchema.pre('save', function(next) {
  console.log(`[${new Date().toISOString()}] Saving notification:`, {
    user: this.user,
    type: this.type,
    messageKey: this.messageKey,
    eventId: this.data.eventId,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);