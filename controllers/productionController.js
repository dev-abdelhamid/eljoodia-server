const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  const isRtl = req.query.isRtl === 'true';
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
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' : 'Order, product, chef, quantity, and item ID are required and must be valid' 
      });
    }

    // التحقق من وجود الطلب
    const orderDoc = await Order.findById(order).session(session).setOptions({ context: { isRtl } });
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ success: false, message: isRtl ? 'يجب الموافقة على الطلب قبل تعيين المهام' : 'Order must be approved before assigning tasks' });
    }

    // التحقق من وجود المنتج
    const productDoc = await Product.findById(product).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }

    // التحقق من الشيف والقسم
    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefProfile.department.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc.department._id,
      });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'الشيف غير صالح أو القسم لا يتطابق' : 'Invalid chef or department mismatch' 
      });
    }

    // التحقق من وجود العنصر في الطلب
    const orderItem = orderDoc.items.find(item => item._id.toString() === itemId);
    if (!orderItem || orderItem.product.toString() !== product.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'العنصر أو المنتج غير صالح في الطلب' : 'Invalid order item or product mismatch' 
      });
    }

    // التحقق من عدم وجود مهمة مكررة
    const existingTask = await ProductionAssignment.findOne({ order, itemId }).session(session);
    if (existingTask) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Task already exists for item: ${itemId}`);
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'المهمة موجودة بالفعل لهذا العنصر' : 'Task already exists for this item' 
      });
    }

    // إنشاء المهمة
    const newTask = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending',
      createdBy: req.user.id,
    });
    await newTask.save({ session });

    // تحديث حالة العنصر في الطلب
    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderDoc.markModified('items');
    await orderDoc.save({ session, context: { isRtl } });

    // جلب بيانات الطلب مع التفاصيل
    const populatedOrder = await Order.findById(order)
      .populate('branch', 'name nameEn')
      .populate({ 
        path: 'items.product', 
        select: 'name nameEn price unit unitEn department', 
        populate: { path: 'department', select: 'name nameEn code' } 
      })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('returns')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    // إعداد بيانات الحدث للـ handler
    const eventData = {
      taskId: newTask._id,
      orderId: order,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      productId: product,
      productName: isRtl ? productDoc.name : (productDoc.nameEn || productDoc.name || 'Unknown'),
      quantity,
      chefId: chef,
      chefName: isRtl ? chefDoc.name : (chefDoc.nameEn || chefDoc.name || 'Unknown'),
      eventId: `${newTask._id}-task_assigned`,
      isRtl,
    };

    // إرسال الحدث إلى handler
    io.emit('taskAssigned', eventData);

    // إعداد بيانات الرد
    const taskData = {
      taskId: newTask._id,
      orderId: order,
      orderNumber: orderDoc.orderNumber,
      branchId: orderDoc.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      productId: product,
      productName: isRtl ? productDoc.name : (productDoc.nameEn || productDoc.name || 'Unknown'),
      quantity,
      chefId: chef,
      chefName: isRtl ? chefDoc.name : (chefDoc.nameEn || chefDoc.name || 'Unknown'),
      status: newTask.status,
      createdAt: new Date(newTask.createdAt).toISOString(),
      isRtl,
    };

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: taskData,
      message: isRtl ? 'تم إنشاء المهمة بنجاح' : 'Task created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: isRtl ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  try {
    const query = req.user.role === 'chef' ? { chef: req.user.id } : {};
    if (req.user.role === 'branch') query.branch = req.user.branchId;
    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber status branch')
      .populate('product', 'name nameEn unit unitEn')
      .populate('chef', 'user')
      .populate({ path: 'chef.user', select: 'name nameEn' })
      .populate('createdBy', 'name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const formattedTasks = tasks.map(task => ({
      taskId: task._id,
      orderId: task.order._id,
      orderNumber: task.order.orderNumber,
      branchId: task.order.branch,
      productId: task.product._id,
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      unit: isRtl ? (task.product.unit || 'غير محدد') : (task.product.unitEn || task.product.unit || 'N/A'),
      quantity: task.quantity,
      chefId: task.chef.user,
      chefName: isRtl ? task.chef.user?.name : (task.chef.user?.nameEn || task.chef.user?.name || 'Unknown'),
      status: task.status,
      createdByName: isRtl ? task.createdBy?.name : (task.createdBy?.nameEn || task.createdBy?.name || 'Unknown'),
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: isRtl ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  }
};

const getChefTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  const { chefId } = req.params;
  try {
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chef ID: ${chefId}`);
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'معرف الشيف غير صالح' : 'Invalid chef ID' 
      });
    }
    if (req.user.role !== 'chef' && req.user.id !== chefId && req.user.role !== 'admin' && req.user.role !== 'production') {
      console.error(`[${new Date().toISOString()}] Unauthorized access to chef tasks:`, { userId: req.user.id, chefId });
      return res.status(403).json({ 
        success: false, 
        message: isRtl ? 'غير مخول لعرض مهام هذا الشيف' : 'Unauthorized to view this chef\'s tasks' 
      });
    }
    const tasks = await ProductionAssignment.find({ 'chef.user': chefId })
      .populate('order', 'orderNumber status branch')
      .populate('product', 'name nameEn unit unitEn')
      .populate('chef', 'user')
      .populate({ path: 'chef.user', select: 'name nameEn' })
      .populate('createdBy', 'name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const formattedTasks = tasks.map(task => ({
      taskId: task._id,
      orderId: task.order._id,
      orderNumber: task.order.orderNumber,
      branchId: task.order.branch,
      productId: task.product._id,
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      unit: isRtl ? (task.product.unit || 'غير محدد') : (task.product.unitEn || task.product.unit || 'N/A'),
      quantity: task.quantity,
      chefId: task.chef.user,
      chefName: isRtl ? task.chef.user?.name : (task.chef.user?.nameEn || task.chef.user?.name || 'Unknown'),
      status: task.status,
      createdByName: isRtl ? task.createdBy?.name : (task.createdBy?.nameEn || task.createdBy?.name || 'Unknown'),
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: isRtl ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const isRtl = req.query.isRtl === 'true';
  try {
    session.startTransaction();
    const { orderId, taskId } = req.params;
    const { status } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order or task ID:`, { orderId, taskId });
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'معرف الطلب أو المهمة غير صالح' : 'Invalid order or task ID' 
      });
    }
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid task status: ${status}`);
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'حالة المهمة غير صالحة' : 'Invalid task status' 
      });
    }

    const task = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber status branch')
      .populate('product', 'name nameEn')
      .populate('chef', 'user')
      .populate({ path: 'chef.user', select: 'name nameEn' })
      .session(session)
      .setOptions({ context: { isRtl } });
    if (!task) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
      return res.status(404).json({ 
        success: false, 
        message: isRtl ? 'المهمة غير موجودة' : 'Task not found' 
      });
    }
    if (task.order._id.toString() !== orderId) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not belong to order ${orderId}`);
      return res.status(400).json({ 
        success: false, 
        message: isRtl ? 'المهمة لا تتعلق بهذا الطلب' : 'Task does not belong to this order' 
      });
    }
    if (req.user.role === 'chef' && task.chef.user.toString() !== req.user.id) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Unauthorized task status update:`, { userId: req.user.id, taskChef: task.chef.user });
      return res.status(403).json({ 
        success: false, 
        message: isRtl ? 'غير مخول لتحديث حالة هذه المهمة' : 'Unauthorized to update this task status' 
      });
    }

    task.status = status;
    if (status === 'in_progress' && !task.startedAt) task.startedAt = new Date();
    if (status === 'completed' && !task.completedAt) task.completedAt = new Date();
    await task.save({ session });

    // تحديث حالة العنصر في الطلب
    const order = await Order.findById(orderId).session(session).setOptions({ context: { isRtl } });
    const orderItem = order.items.find(item => item._id.toString() === task.itemId.toString());
    if (orderItem) {
      orderItem.status = status;
      if (status === 'in_progress' && !orderItem.startedAt) orderItem.startedAt = new Date();
      if (status === 'completed' && !orderItem.completedAt) orderItem.completedAt = new Date();
      order.markModified('items');
    }

    // التحقق مما إذا كانت جميع العناصر مكتملة
    const allItemsCompleted = order.items.every(item => item.status === 'completed');
    if (allItemsCompleted && order.status !== 'completed') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        notes: isRtl ? 'تم إكمال جميع العناصر' : 'All items completed',
        notesEn: 'All items completed',
        changedAt: new Date(),
      });
    }
    await order.save({ session, context: { isRtl } });

    // جلب بيانات المهمة مع التفاصيل
    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber status branch')
      .populate('product', 'name nameEn unit unitEn')
      .populate('chef', 'user')
      .populate({ path: 'chef.user', select: 'name nameEn' })
      .populate('createdBy', 'name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    // إعداد بيانات الحدث للـ handler
    const eventData = {
      taskId: task._id,
      orderId,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedTask.order.branch?.name : (populatedTask.order.branch?.nameEn || populatedTask.order.branch?.name || 'Unknown'),
      productId: task.product,
      productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
      quantity: task.quantity,
      chefId: task.chef.user,
      chefName: isRtl ? populatedTask.chef.user?.name : (populatedTask.chef.user?.nameEn || populatedTask.chef.user?.name || 'Unknown'),
      status,
      eventId: `${taskId}-task_status_updated-${status}`,
      isRtl,
    };

    // إرسال الحدث إلى handler
    io.emit('taskStatusUpdated', eventData);

    // إذا اكتمل الطلب، إرسال حدث orderStatusUpdated
    if (allItemsCompleted) {
      const orderEventData = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        status: 'completed',
        isRtl,
        eventId: `${orderId}-order_completed`,
      };
      io.emit('orderStatusUpdated', orderEventData);
    }

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      data: {
        taskId: populatedTask._id,
        orderId: populatedTask.order._id,
        orderNumber: populatedTask.order.orderNumber,
        branchId: populatedTask.order.branch,
        productId: populatedTask.product._id,
        productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
        unit: isRtl ? (populatedTask.product.unit || 'غير محدد') : (populatedTask.product.unitEn || populatedTask.product.unit || 'N/A'),
        quantity: populatedTask.quantity,
        chefId: populatedTask.chef.user,
        chefName: isRtl ? populatedTask.chef.user?.name : (populatedTask.chef.user?.nameEn || populatedTask.chef.user?.name || 'Unknown'),
        status: populatedTask.status,
        createdByName: isRtl ? populatedTask.createdBy?.name : (populatedTask.createdBy?.nameEn || populatedTask.createdBy?.name || 'Unknown'),
        createdAt: new Date(populatedTask.createdAt).toISOString(),
        startedAt: populatedTask.startedAt ? new Date(populatedTask.startedAt).toISOString() : null,
        completedAt: populatedTask.completedAt ? new Date(populatedTask.completedAt).toISOString() : null,
        isRtl,
      },
      message: isRtl ? 'تم تحديث حالة المهمة بنجاح' : 'Task status updated successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ 
      success: false, 
      message: isRtl ? 'خطأ في السيرفر' : 'Server error', 
      error: err.message 
    });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session) => {
  try {
    const order = await Order.findById(orderId).session(session).setOptions({ context: { isRtl: true } });
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found for syncOrderTasks: ${orderId}`);
      return;
    }
    const tasks = await ProductionAssignment.find({ order: orderId }).session(session);
    const taskMap = new Map(tasks.map(task => [task.itemId.toString(), task]));
    for (const item of order.items) {
      if (!taskMap.has(item._id.toString()) && order.status === 'approved') {
        const chefProfile = await mongoose.model('Chef').findOne({ department: item.product.department }).session(session);
        if (chefProfile) {
          const newTask = new ProductionAssignment({
            order: orderId,
            product: item.product,
            chef: chefProfile._id,
            quantity: item.quantity,
            itemId: item._id,
            status: 'pending',
            createdBy: order.createdBy,
          });
          await newTask.save({ session });
          item.status = 'assigned';
          item.assignedTo = chefProfile.user;
          const eventData = {
            taskId: newTask._id,
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch,
            productId: item.product,
            quantity: item.quantity,
            chefId: chefProfile.user,
            eventId: `${newTask._id}-task_assigned`,
            isRtl: true,
          };
          io.emit('taskAssigned', eventData);
        }
      }
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, {
      error: err.message,
      orderId,
      stack: err.stack,
    });
    throw err;
  }
};

module.exports = {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus,
  syncOrderTasks,
};