const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: [
      'order_created',
      'order_approved',
      'order_status_updated',
      'task_assigned',
      'task_status_updated',
      'task_completed',
      'order_completed',
      'order_in_transit',
      'order_delivered',
      'return_created',
      'return_status_updated',
      'missing_assignments',
    ],
    required: true,
  },
  message: { type: String, required: true, trim: true },
  data: { type: Object, default: {} },
  read: { type: Boolean, default: false },
  sound: { type: String, default: '/assets/notification.mp3' },
  vibrate: { type: [Number], default: [200, 100, 200] },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }, // إضافة حقل branch
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Notification', notificationSchema);