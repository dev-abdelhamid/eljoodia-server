// models/Notification.js
const mongoose = require('mongoose');
const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    required: true,
    enum: ['order_created', 'order_status_updated', 'return_created', 'return_status_updated', 'task_completed',     'task_assigned', 'task_status_updated', 'order_delivered'],
  },
  message: { type: String, required: true },
  data: { type: Object, default: {} },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);