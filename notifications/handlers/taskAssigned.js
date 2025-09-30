const Notification = require('../../models/Notification');
const Product = require('../../models/Product');
const Branch = require('../../models/Branch');

const handleTaskAssigned = async (io, eventData) => {
  const { taskId, orderId, orderNumber, branchId, branchName, productId, productName, quantity, chefId, chefName, eventId, isRtl } = eventData;

  try {
    // التحقق من عدم تكرار الحدث
    const existingNotification = await Notification.findOne({ eventId });
    if (existingNotification) {
      console.log(`[${new Date().toISOString()}] Duplicate taskAssigned event ignored: ${eventId}`);
      return;
    }

    // جلب بيانات إضافية إذا لزم الأمر
    const product = await Product.findById(productId).select('unit unitEn').lean();
    const unit = isRtl ? (product?.unit || 'غير محدد') : (product?.unitEn || product?.unit || 'N/A');

    // إنشاء الإشعار للشيف
    const notification = new Notification({
      eventId,
      type: 'taskAssigned',
      message: isRtl
        ? `تم تعيين مهمة لإنتاج ${quantity} ${unit} من ${productName} في الطلب ${orderNumber} من ${branchName}`
        : `Assigned task to produce ${quantity} ${unit} of ${productName} for order ${orderNumber} from ${branchName}`,
      recipients: [chefId],
      data: {
        taskId,
        orderId,
        orderNumber,
        branchId,
        productId,
        productName,
        quantity,
        unit,
      },
      createdAt: new Date(),
    });

    await notification.save();

    // إرسال الإشعار إلى الشيف
    io.to(`user-${chefId}`).emit('notification', {
      notificationId: notification._id,
      type: 'taskAssigned',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });
    io.to(`chef-${chefId}`).emit('notification', {
      notificationId: notification._id,
      type: 'taskAssigned',
      message: notification.message,
      data: notification.data,
      createdAt: notification.createdAt.toISOString(),
      isRtl,
    });

    console.log(`[${new Date().toISOString()}] Task assigned notification sent:`, { eventId, taskId, chefId });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error handling taskAssigned:`, {
      error: err.message,
      eventId,
      stack: err.stack,
    });
  }
};

module.exports = handleTaskAssigned;