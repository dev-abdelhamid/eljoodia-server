const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Product = require('../../models/Product');
const Branch = require('../../models/Branch');

const handleTaskStatusUpdated = async (io, eventData) => {
  const { taskId, orderId, orderNumber, branchId, branchName, productId, productName, quantity, chefId, chefName, status, eventId, isRtl } = eventData;

  try {
    // التحقق من عدم تكرار الحدث
    const existingNotification = await Notification.findOne({ eventId });
    if (existingNotification) {
      console.log(`[${new Date().toISOString()}] Duplicate taskStatusUpdated event ignored: ${eventId}`);
      return;
    }

    // جلب بيانات إضافية
    const product = await Product.findById(productId).select('unit unitEn').lean();
    const unit = isRtl ? (product?.unit || 'غير محدد') : (product?.unitEn || product?.unit || 'N/A');

    // جلب المستخدمين المعنيين
    const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id');
    const recipients = [...users.map(user => user._id.toString()), chefId];

    // إنشاء الإشعار
    const statusMessages = {
      pending: isRtl ? `مهمة ${productName} (الطلب ${orderNumber}) في انتظار البدء` : `Task ${productName} (order ${orderNumber}) is pending`,
      in_progress: isRtl ? `مهمة ${productName} (الطلب ${orderNumber}) قيد التنفيذ` : `Task ${productName} (order ${orderNumber}) is in progress`,
      completed: isRtl ? `اكتملت مهمة ${productName} (الطلب ${orderNumber})` : `Task ${productName} (order ${orderNumber}) completed`,
    };

    const notification = new Notification({
      eventId,
      type: 'taskStatusUpdated',
      message: statusMessages[status] || (isRtl ? `تم تحديث حالة المهمة ${productName} (الطلب ${orderNumber}) إلى ${status}` : `Task ${productName} (order ${orderNumber}) status updated to ${status}`),
      recipients,
      data: {
        taskId,
        orderId,
        orderNumber,
        branchId,
        productId,
        productName,
        quantity,
        unit,
        status,
      },
      createdAt: new Date(),
    });

    await notification.save();

    // إرسال الإشعار إلى الغرف
    recipients.forEach(userId => {
      io.to(`user-${userId}`).emit('notification', {
        notificationId: notification._id,
        type: 'taskStatusUpdated',
        message: notification.message,
        data: notification.data,
        createdAt: notification.createdAt.toISOString(),
        isRtl,
      });
    });
    io.to('admin').emit('notification', {
      notificationId: notification._id,
      type: 'taskStatusUpdated',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });
    io.to('production').emit('notification', {
      notificationId: notification._id,
      type: 'taskStatusUpdated',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });
    io.to(`chef-${chefId}`).emit('notification', {
      notificationId: notification._id,
      type: 'taskStatusUpdated',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });

    console.log(`[${new Date().toISOString()}] Task status updated notification sent:`, { eventId, taskId, status, recipients: recipients.length });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error handling taskStatusUpdated:`, {
      error: err.message,
      eventId,
      stack: err.stack,
    });
  }
};

module.exports = handleTaskStatusUpdated;