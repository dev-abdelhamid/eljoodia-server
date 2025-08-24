const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const notificationSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true, // فهرسة لتحسين الاستعلامات
  },
  type: {
    type: String,
    required: true,
    enum: [
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
    required: true,
  },
  data: {
    type: Schema.Types.Mixed,
    default: {},
  },
  read: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: { expireAfterSeconds: 2592000 }, // حذف تلقائي بعد 30 يوم
  },
}, {
  timestamps: true,
});

notificationSchema.pre('save', function (next) {
  console.log(`[${new Date().toISOString()}] Saving notification:`, { type: this.type, message: this.message });
  next();
});

module.exports = mongoose.model('Notification', notificationSchema);