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
      'orderCreated', 'orderConfirmed', 'taskAssigned', 'itemStatusUpdated',
      'orderStatusUpdated', 'orderCompleted', 'orderShipped', 'orderDelivered',
      'returnStatusUpdated', 'missingAssignments', 'orderApproved', 'orderInTransit',
      'branchConfirmedReceipt', 'taskStarted', 'taskCompleted'
    ],
  },
  displayType: { // للتوافق مع frontend (success, info, etc.)
    type: String,
    required: true,
    enum: ['success', 'info', 'warning', 'error'],
  },
  messageKey: {
    type: String,
    required: true,
  },
  params: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  message: {
    type: String,
    default: '',
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
  },
}, {
  timestamps: true,
});

notificationSchema.pre('save', function(next) {
  console.log(`[${new Date().toISOString()}] Saving notification:`, {
    user: this.user,
    type: this.type,
    displayType: this.displayType,
    messageKey: this.messageKey,
    params: this.params,
    data: this.data,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);