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
      'orderCreated', 'orderCompleted', 'taskAssigned', 'orderApproved', 'orderInTransit', 
      'orderDelivered', 'branchConfirmedReceipt', 'taskStarted', 'taskCompleted',
      'itemStatusUpdated', 'orderStatusUpdated', 'returnStatusUpdated', 'missingAssignments', // أضفت الناقصة
      'orderConfirmed', 'orderShipped' // للتوافق مع Frontend
    ],
  },
  messageKey: { // جديد: مفتاح الترجمة
    type: String,
    required: true,
  },
  params: { // جديد: params لـ t
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  message: { // احتفظ بها optional للـ fallback
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