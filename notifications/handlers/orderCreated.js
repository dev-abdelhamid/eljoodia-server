const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Branch = require('../../models/Branch');

const handleOrderCreated = async (io, eventData) => {
  const { orderId, orderNumber, branchId, isRtl, totalQuantity, totalAmount, eventId } = eventData;

  try {
    // التحقق من عدم تكرار الحدث
    const existingNotification = await Notification.findOne({ eventId });
    if (existingNotification) {
      console.log(`[${new Date().toISOString()}] Duplicate orderCreated event ignored: ${eventId}`);
      return;
    }

    // جلب اسم الفرع
    const branch = await Branch.findById(branchId).select('name nameEn').lean();
    const branchName = isRtl ? branch?.name : (branch?.nameEn || branch?.name || 'Unknown');

    // جلب المستخدمين المعنيين (الإداريون وفريق الإنتاج)
    const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id');
    const userIds = users.map(user => user._id.toString());

    // إنشاء الإشعار
    const notification = new Notification({
      eventId,
      type: 'orderCreated',
      message: isRtl
        ? `تم إنشاء طلب جديد رقم ${orderNumber} من الفرع ${branchName} بإجمالي ${totalQuantity} عنصر بقيمة ${totalAmount}`
        : `New order ${orderNumber} created by branch ${branchName} with ${totalQuantity} items, total ${totalAmount}`,
      recipients: userIds,
      data: {
        orderId,
        orderNumber,
        branchId,
        totalQuantity,
        totalAmount,
      },
      createdAt: new Date(),
    });

    await notification.save();

    // إرسال الإشعار إلى الغرف المناسبة
    userIds.forEach(userId => {
      io.to(`user-${userId}`).emit('notification', {
        notificationId: notification._id,
        type: 'orderCreated',
        message: notification.message,
        data: notification.data,
        createdAt: notification.createdAt.toISOString(),
        isRtl,
      });
    });
    io.to('admin').emit('notification', {
      notificationId: notification._id,
      type: 'orderCreated',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });
    io.to('production').emit('notification', {
      notificationId: notification._id,
      type: 'orderCreated',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });

    console.log(`[${new Date().toISOString()}] Order created notification sent:`, { eventId, orderId, recipients: userIds.length });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error handling orderCreated:`, {
      error: err.message,
      eventId,
      stack: err.stack,
    });
  }
};

module.exports = handleOrderCreated;