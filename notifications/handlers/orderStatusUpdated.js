const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Branch = require('../../models/Branch');

const handleOrderStatusUpdated = async (io, eventData) => {
  const { orderId, orderNumber, branchId, status, isRtl, eventId } = eventData;

  try {
    // التحقق من عدم تكرار الحدث
    const existingNotification = await Notification.findOne({ eventId });
    if (existingNotification) {
      console.log(`[${new Date().toISOString()}] Duplicate orderStatusUpdated event ignored: ${eventId}`);
      return;
    }

    // جلب اسم الفرع
    const branch = await Branch.findById(branchId).select('name nameEn').lean();
    const branchName = isRtl ? branch?.name : (branch?.nameEn || branch?.name || 'Unknown');

    // تحديد المستلمين بناءً على الحالة
    let recipients = [];
    let rooms = [];
    if (['pending', 'approved', 'in_production', 'completed'].includes(status)) {
      const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id');
      recipients = users.map(user => user._id.toString());
      rooms = ['admin', 'production'];
    }
    if (['in_transit', 'delivered'].includes(status)) {
      const users = await User.find({ $or: [{ role: 'branch', branchId }, { role: { $in: ['admin', 'production'] } }] }).select('_id');
      recipients = users.map(user => user._id.toString());
      rooms = ['admin', 'production', `branch-${branchId}`];
    }

    // إنشاء الإشعار
    const statusMessages = {
      pending: isRtl ? `الطلب ${orderNumber} في انتظار الموافقة` : `Order ${orderNumber} is pending approval`,
      approved: isRtl ? `تمت الموافقة على الطلب ${orderNumber} من ${branchName}` : `Order ${orderNumber} approved by ${branchName}`,
      in_production: isRtl ? `الطلب ${orderNumber} قيد الإنتاج` : `Order ${orderNumber} is in production`,
      completed: isRtl ? `اكتمل الطلب ${orderNumber}` : `Order ${orderNumber} completed`,
      in_transit: isRtl ? `الطلب ${orderNumber} في الطريق إلى ${branchName}` : `Order ${orderNumber} is in transit to ${branchName}`,
      delivered: isRtl ? `تم تسليم الطلب ${orderNumber} إلى ${branchName}` : `Order ${orderNumber} delivered to ${branchName}`,
    };

    const notification = new Notification({
      eventId,
      type: 'orderStatusUpdated',
      message: statusMessages[status] || (isRtl ? `تم تحديث حالة الطلب ${orderNumber} إلى ${status}` : `Order ${orderNumber} status updated to ${status}`),
      recipients,
      data: {
        orderId,
        orderNumber,
        branchId,
        status,
      },
      createdAt: new Date(),
    });

    await notification.save();

    // إرسال الإشعار إلى الغرف
    recipients.forEach(userId => {
      io.to(`user-${userId}`).emit('notification', {
        notificationId: notification._id,
        type: 'orderStatusUpdated',
        message: notification.message,
        data: notification.data,
        createdAt: notification.createdAt.toISOString(),
        isRtl,
      });
    });
    rooms.forEach(room => {
      io.to(room).emit('notification', {
        notificationId: notification._id,
        type: 'orderStatusUpdated',
        message: notification.message,
        data: notification.data,
        createdAt: notification.createdAt.toISOString(),
        isRtl,
      });
    });

    console.log(`[${new Date().toISOString()}] Order status updated notification sent:`, { eventId, orderId, status, recipients: recipients.length });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error handling orderStatusUpdated:`, {
      error: err.message,
      eventId,
      stack: err.stack,
    });
  }
};

module.exports = handleOrderStatusUpdated;