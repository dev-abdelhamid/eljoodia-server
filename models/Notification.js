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
      'order_approved_for_branch',
      'new_production_assigned_to_chef',
      'order_completed_by_chefs',
      'order_in_transit_to_branch',
      'order_delivered',
      'branch_confirmed_receipt',
      'return_status_updated',
      'order_status_updated',
      'task_assigned',
      'missing_assignments',
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
  priority: {
    type: String,
    enum: ['urgent', 'high', 'medium', 'low'],
    default: 'medium',
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
}, {
  timestamps: true,
});

notificationSchema.pre('save', function(next) {
  console.log(`[${new Date().toISOString()}] Pre-save hook for notification:`, {
    user: this.user,
    type: this.type,
    message: this.message,
    data: this.data,
    priority: this.priority,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);