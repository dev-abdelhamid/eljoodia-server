const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { 
    type: String, 
    required: true, 
    enum: ['orderCreated', 'orderStatusUpdated', 'taskAssigned', 'taskStatusUpdated', 'orderCancelled'] 
  },
  message: { type: String, required: true },
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
});

module.exports = mongoose.model('Notification', notificationSchema);