const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

// ذاكرة مؤقتة داخلية لتخزين بيانات الفروع والمستخدمين
const cache = new Map();

// دالة مركزية لإرسال الإشعارات وأحداث الـ socket
const sendNotifications = async (io, users, eventType, message, data, rooms, eventName) => {
  const timestamp = new Date().toISOString();
  const notificationSet = new Set(); // لمنع إرسال إشعارات مكررة لنفس المستخدم
  console.log(`[${timestamp}] Preparing to notify users for ${eventType}:`, {
    users: users.map(u => u._id),
    message,
    data,
    rooms,
  });

  // إرسال الإشعارات بشكل دفعي
  await Promise.all(
    users
      .filter(user => user.isActive !== false) // التحقق من حالة المستخدم
      .map(user => {
        if (!notificationSet.has(user._id.toString())) {
          notificationSet.add(user._id.toString());
          return createNotification(user._id, eventType, message, {
            ...data,
            timestamp,
            sound: '/sounds/notification.mp3',
            vibrate: [200, 100, 200],
          }, io);
        }
        return Promise.resolve();
      })
  );

  // إرسال حدث socket
  const eventData = {
    ...data,
    message,
    eventType,
    timestamp,
    sound: '/sounds/notification.mp3',
    vibrate: [200, 100, 200],
  };
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${timestamp}] Emitted ${eventName}:`, { rooms, eventData });
};

// جلب اسم الفرع من الذاكرة المؤقتة أو قاعدة البيانات
const getBranchName = async (branchId, session) => {
  if (cache.has(branchId)) {
    return cache.get(branchId);
  }
  const branch = await mongoose.model('Branch').findById(branchId).select('name').lean().session(session);
  const branchName = branch?.name || 'Unknown';
  cache.set(branchId, branchName);
  return branchName;
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    // التحقق من صحة البيانات
    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) ||
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

    // جلب الطلب
    const orderDoc = await Order.findById(order).session(session);
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل تعيين المهام' });
    }

    // جلب المنتج وقسمه
    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    // التحقق من الشيف وقسمه
    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session);
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id
      });
      return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
    }

    // التحقق من عنصر الطلب
    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });

    // إنشاء المهمة
    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending'
    });
    await newAssignment.save({ session });

    // تحديث عنصر الطلب
    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    // مزامنة المهام
    await syncOrderTasks(order._id, io, session);

    // جلب اسم الفرع
    const branchName = await getBranchName(orderDoc.branch, session);

    // إعداد بيانات الإشعار وحدث الـ socket
    const taskData = {
      taskId: newAssignment._id,
      orderId: order,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      branchName,
      productName: productDoc.name,
      quantity,
      itemId,
    };

    // إرسال الإشعارات
    await sendNotifications(
      io,
      [{ _id: chef }],
      'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} (الكمية: ${quantity}) في الطلب ${orderDoc.orderNumber}`,
      taskData,
      [`chef-${chefProfile._id}`, 'admin', 'production', `branch-${orderDoc.branch}`],
      'taskAssigned'
    );

    await session.commitTransaction();

    // جلب بيانات المهمة بعد الإنشاء
    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    res.status(201).json(populatedAssignment);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .sort({ updatedAt: -1 })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId && task.quantity > 0);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId || task.quantity <= 0)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId, quantity: t.quantity })));
    }

    res.status(200).json(validTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    // التحقق من صحة المعرفات
    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    // جلب المهمة
    const task = await ProductionAssignment.findById(taskId).populate('order').populate('product').session(session);
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المهمة غير موجودة' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف العنصر مفقود في المهمة' });
    }
    if (task.order._id.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match order ${orderId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة لا تتطابق مع الطلب' });
    }

    // التحقق من صلاحية الشيف
    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

    // التحقق من الحالة
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المهمة مكتملة بالفعل' });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}`);

    // تحديث حالة المهمة
    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    // تحديث عنصر الطلب
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `العنصر ${task.itemId} غير موجود في الطلب` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    console.log(`[${new Date().toISOString()}] Updated order item ${task.itemId} status to ${status}`);

    // تحديث حالة الطلب إذا لزم الأمر
    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date()
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'in_production'`);

      const branchName = await getBranchName(order.branch, session);
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch },
          { role: { $in: ['chef', 'admin'] } }
        ],
        isActive: true
      }).select('_id').lean();

      await sendNotifications(
        io,
        usersToNotify,
        'order_status_updated',
        `بدأ إنتاج الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName },
        [`branch-${order.branch}`, 'admin', 'production'],
        'orderStatusUpdated'
      );
    }

    order.markModified('items');
    await order.save({ session });

    // مزامنة المهام
    await syncOrderTasks(orderId, io, session);

    // إعداد بيانات الإشعار وحدث الـ socket
    const branchName = await getBranchName(order.branch, session);
    const taskData = {
      taskId,
      status,
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName,
      productName: task.product.name,
      quantity: task.quantity,
      itemId: task.itemId,
      chefId: task.chef._id,
    };

    // إرسال إشعار إكمال المهمة
    if (status === 'completed') {
      await sendNotifications(
        io,
        [{ _id: task.chef._id }],
        'task_completed',
        `تم إكمال مهمة ${task.product.name} (الكمية: ${task.quantity}) للطلب ${task.order.orderNumber}`,
        taskData,
        [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'],
        'taskCompleted'
      );

      // التحقق مما إذا كانت جميع المهام مكتملة لتحديث حالة الطلب
      const allTasks = await ProductionAssignment.find({ order: orderId }).session(session);
      if (allTasks.every(t => t.status === 'completed') && order.status !== 'completed') {
        order.status = 'completed';
        order.completedAt = new Date();
        order.statusHistory.push({
          status: 'completed',
          changedBy: req.user.id,
          changedAt: new Date(),
        });
        await order.save({ session });
        console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'completed'`);

        const usersToNotify = await User.find({
          $or: [
            { role: { $in: ['production', 'admin'] } },
            { role: 'branch', branchId: order.branch }
          ],
          isActive: true
        }).select('_id').lean();

        await sendNotifications(
          io,
          usersToNotify,
          'order_completed_by_chefs',
          `تم إكمال الطلب ${order.orderNumber} بواسطة الشيفات`,
          { orderId, orderNumber: order.orderNumber, branchId: order.branch, branchName, completedAt: new Date().toISOString() },
          [`branch-${order.branch}`, 'admin', 'production'],
          'orderCompletedByChefs'
        );
      }
    } else {
      await sendNotifications(
        io,
        [{ _id: task.chef._id }],
        'task_status_updated',
        `تم تحديث حالة المهمة ${task.product.name} إلى ${status} للطلب ${task.order.orderNumber}`,
        taskData,
        [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'],
        'taskStatusUpdated'
      );
    }

    await session.commitTransaction();

    // جلب بيانات المهمة بعد التحديث
    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .lean();

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).populate('items.product').session(session);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    const branchName = await getBranchName(order.branch, session);

    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await sendNotifications(
          io,
          [{ _id: task.chef._id }],
          'item_status_updated',
          `تم تحديث حالة العنصر ${item.product.name} إلى ${task.status} في الطلب ${order.orderNumber}`,
          {
            orderId,
            itemId: item._id,
            status: task.status,
            productName: item.product.name,
            quantity: task.quantity,
            orderNumber: order.orderNumber,
            branchId: order.branch,
            branchName,
          },
          [`branch-${order.branch}`, 'production', 'admin', `department-${item.product.department?._id}`, 'all-departments'],
          'itemStatusUpdated'
        );
      }
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };