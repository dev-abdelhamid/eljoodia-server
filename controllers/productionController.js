const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = new Set(rooms);
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms: [...uniqueRooms],
    eventData: eventDataWithSound,
  });
};

const notifyUsers = async (io, users, type, message, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err.message);
    }
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) throw new Error('الطلب غير موجود');

    const missingAssignments = order.items.filter(item => item.status === 'pending' && !item.assignedTo);
    if (missingAssignments.length > 0) {
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean();
      await notifyUsers(
        io,
        usersToNotify,
        'missing_assignments',
        `الطلب ${order.orderNumber} يحتاج إلى تعيينات إضافية`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${orderId}-missing_assignments` }
      );
      await emitSocketEvent(io, ['admin', 'production'], 'missingAssignments', {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        missingItems: missingAssignments.map(item => ({
          itemId: item._id,
          productName: item.product.name,
        })),
        eventId: `${orderId}-missing_assignments`,
      });
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err.message);
    throw err;
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || !mongoose.isValidObjectId(itemId)) {
      throw new Error('معرفات الطلب، المنتج، الشيف، الكمية، ومعرف العنصر مطلوبة');
    }

    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) throw new Error('الطلب غير موجود');
    if (orderDoc.status !== 'approved') throw new Error('يجب الموافقة على الطلب قبل تعيين المهام');

    const productDoc = await mongoose.model('Product').findById(product).populate('department').session(session);
    if (!productDoc) throw new Error('المنتج غير موجود');

    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      throw new Error('الشيف غير صالح أو غير متطابق مع قسم المنتج');
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      throw new Error(`العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج`);
    }

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef,
      quantity,
      itemId,
      status: 'pending',
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'username')
      .lean();

    await notifyUsers(
      io,
      [{ _id: chef }],
      'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch, eventId: `${newAssignment._id}-task_assigned` }
    );

    await emitSocketEvent(io, [`chef-${chef}`, `branch-${orderDoc.branch}`, 'admin', 'production'], 'taskAssigned', {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      eventId: `${newAssignment._id}-task_assigned`,
    });

    await session.commitTransaction();
    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      throw new Error('معرف الطلب أو المهمة غير صالح');
    }
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      throw new Error('حالة غير صالحة');
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
    if (!task) throw new Error('المهمة غير موجودة');
    if (task.order._id.toString() !== orderId) throw new Error('المهمة لا تتطابق مع الطلب');
    if (task.chef.toString() !== req.user.id) throw new Error('غير مخول لتحديث هذه المهمة');

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session);
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) throw new Error(`العنصر ${task.itemId} غير موجود في الطلب`);
    orderItem.status = status;
    order.markModified('items');
    await order.save({ session });

    if (status === 'completed') {
      const allItemsCompleted = order.items.every(item => item.status === 'completed');
      if (allItemsCompleted) {
        order.status = 'completed';
        order.statusHistory.push({ status: 'completed', changedBy: req.user.id, changedAt: new Date() });
        await order.save({ session });

        const usersToNotify = await User.find({
          $or: [
            { role: { $in: ['admin', 'production'] } },
            { role: 'branch', branch: order.branch },
          ],
        }).select('_id').lean();

        await notifyUsers(
          io,
          usersToNotify,
          'order_completed_by_chefs',
          `تم إكمال الطلب ${order.orderNumber}`,
          { orderId, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${orderId}-order_completed_by_chefs` }
        );

        await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompletedByChefs', {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch,
          eventId: `${orderId}-order_completed_by_chefs`,
        });
      }
    }

    await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', {
      taskId,
      status,
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      eventId: `${taskId}-task_status_updated`,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, task });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createTask, updateTaskStatus, syncOrderTasks };