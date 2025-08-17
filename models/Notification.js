const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: [
      'order_created',
      'order_status_updated',
      'order_delivered',
      'return_status_updated',
      'task_assigned', // أضف هذه القيمة
      'task_status_updated',
      'task_completed',
    ],
    required: true,
  },
  message: { type: String, required: true },
  data: { type: Object },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Notification', notificationSchema);