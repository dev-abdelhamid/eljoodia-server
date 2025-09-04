const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const notificationSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  user: { type: String, ref: 'User', required: true, index: true },
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
      'order_status_updated',
      'task_assigned',
      'task_completed',
      'return_status_updated',
      'missing_assignments',
    ],
  },
  message: { type: String, required: true, trim: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  eventId: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, index: { expires: '30d' } },
}, { timestamps: true });

notificationSchema.index({ eventId: 1, user: 1 }, { unique: true });

notificationSchema.pre('save', function (next) {
  console.log(`[${new Date().toISOString()}] Saving notification:`, {
    user: this.user,
    type: this.type,
    message: this.message,
    eventId: this.eventId,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);