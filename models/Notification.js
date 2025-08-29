const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const notificationSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: uuidv4,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['success', 'error', 'info', 'warning'],
    },
    event: {
      type: String,
      required: true,
      enum: [
        'order_created',
        'order_approved',
        'task_assigned',
        'task_completed',
        'order_confirmed',
        'order_in_transit',
        'order_delivered',
        'return_status_updated',
        'missing_assignments',
      ],
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    data: {
      orderId: { type: String, index: true },
      returnId: { type: String, index: true },
      taskId: { type: String, index: true },
      branchId: { type: String, index: true },
      chefId: { type: String, index: true },
      departmentId: { type: String, index: true },
      productName: String,
      orderNumber: String,
      status: String,
      eventId: { type: String, unique: true },
      path: String, // لتحديد المسار في السايدبار
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
    sound: {
      type: String,
      default: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    },
    vibrate: {
      type: [Number],
      default: [200, 100, 200],
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.pre('save', function (next) {
  console.log(`[${new Date().toISOString()}] Saving notification:`, {
    user: this.user,
    type: this.type,
    event: this.event,
    message: this.message,
    data: this.data,
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);