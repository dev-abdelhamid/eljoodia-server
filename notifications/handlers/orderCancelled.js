const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Branch = require('../../models/Branch');

const handleOrderCancelled = async (io, eventData) => {
  const { orderId, orderNumber, branchId, isRtl, eventId, reason } = eventData;

  try {
    // التحقق من عدم تكرار الحدث
    const existingNotification = await Notification.findOne({ eventId });
    if (existingNotification) {
      console.log(`[${new Date().toISOString()}] Duplicate orderCancelled event ignored: ${eventId}`);
      return;
    }

    // جلب اسم الفرع
    const branch = await Branch.findById(branchId).select('name nameEn').lean();
    const branchName = isRtl ? branch?.name : (branch?.nameEn || branch?.name || 'Unknown');

    // جلب المستخدمين المعنيين
    const users = await User.find({ $or: [{ role: 'branch', branchId }, { role: { $in: ['admin', 'production'] } }] }).select('_id');
    const recipients = users.map(user => user._id.toString());

    // إنشاء الإشعار
    const message = isRtl
      ? `تم إلغاء الطلب ${orderNumber} من ${branchName}${reason ? ` بسبب: ${reason}` : ''}`
      : `Order ${orderNumber} cancelled by ${branchName}${reason ? ` due to: ${reason}` : ''}`;

    const notification = new Notification({
      eventId,
      type: 'orderCancelled',
      message,
      recipients,
      data: {
        orderId,
        orderNumber,
        branchId,
        reason,
      },
      createdAt: new Date(),
    });

    await notification.save();

    // إرسال الإشعار إلى الغرف
    recipients.forEach(userId => {
      io.to(`user-${userId}`).emit('notification', {
        notificationId: notification._id,
        type: 'orderCancelled',
        message: notification.message,
        data: notification.data,
        createdAt: notification.createdAt.toISOString(),
        isRtl,
      });
    });
    io.to('admin').emit('notification', {
      notificationId: notification._id,
      type: 'orderCancelled',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });
    io.to('production').emit('notification', {
      notificationId: notification._id,
      type: 'orderCancelled',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });
    io.to(`branch-${branchId}`).emit('notification', {
      notificationId: notification._id,
      type: 'orderCancelled',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });

    console.log(`[${new Date().toISOString()}] Order cancelled notification sent:`, { eventId, orderId, recipients: recipients.length });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error handling orderCancelled:`, {
      error: err.message,
      eventId,
      stack: err.stack,
    });
  }
};

module.exports = handleOrderCancelled;