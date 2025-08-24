const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const notificationSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: [
      'order_created',
      'order_approved',
      'order_in_transit',
      'order_confirmed',
      'order_status_updated',
      'task_assigned',
      'task_completed',
      'order_completed',
      'order_completed_by_chefs',
      'order_delivered',
      'return_created',
      'return_status_updated',
      'missing_assignments',
      'new_order_from_branch', // طلب جديد من فرع
      'branch_confirmed_receipt', // تأكيد استلام من الفرع
      'new_order_for_production', // طلب جديد لمدير الإنتاج
      'order_completed_by_chefs', // اكمال تنفيذ من الشيفات
      'order_approved_for_branch', // اعتماد الطلب للفرع
      'order_in_transit_to_branch', // طلب قيد التوصيل (في الطريق)
      'new_production_assigned_to_chef', // تم تعيين إنتاج جديد للشيف
    ],
  
  },
  message: {
    type: String,
    required: true
  },
  data: {
    type: Schema.Types.Mixed,
    default: {}
  },
  read: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  sound: {
    type: String,
    default: '/sounds/notification.mp3'
  },
  vibrate: {
    type: [Number],
    default: [200, 100, 200]
  }
}, {
  timestamps: true
});

notificationSchema.pre('save', function(next) {
  console.log(`[${new Date().toISOString()}] Pre-save hook for notification:`, {
    user: this.user,
    type: this.type,
    message: this.message,
    data: this.data,
    sound: this.sound,
    vibrate: this.vibrate
  });
  next();
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);