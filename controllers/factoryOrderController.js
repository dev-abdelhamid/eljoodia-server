const mongoose = require('mongoose');
const FactoryOrder = require('../models/FactoryOrder');
const Product = require('../models/Product');
const User = require('../models/User');
const ProductionAssignment = require('../models/ProductionAssignment');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const { createNotification } = require('../utils/notifications');

// دالة للتحقق من صحة ObjectId
const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// دالة للتحقق من انتقال الحالة الصحيح
const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
};

// دالة لإرسال حدث عبر WebSocket
const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

// دالة لإشعار المستخدمين
const notifyUsers = async (io, users, type, message, data, saveToDb = false) => {
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

// دالة لتنسيق استجابة الطلب
const formatOrderResponse = (order, isRtl) => {
  if (!order) {
    return null;
  }
  return {
    _id: order._id,
    orderNumber: order.orderNumber,
    items: order.items?.map(item => ({
      _id: item._id,
      product: item.product ? {
        _id: item.product._id,
        name: isRtl ? item.product.name : (item.product.nameEn || item.product.name || 'Unknown'),
        unit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
        department: item.product.department ? {
          _id: item.product.department._id,
          name: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
        } : null,
      } : null,
      quantity: item.quantity,
      status: item.status,
      assignedTo: item.assignedTo ? {
        _id: item.assignedTo._id,
        name: isRtl ? item.assignedTo.name : (item.assignedTo.nameEn || item.assignedTo.name || 'غير معين'),
      } : null,
      startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
      completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
      isCompleted: item.status === 'completed',
    })) || [],
    status: order.status,
    notes: order.notes || '',
    priority: order.priority || 'medium',
    createdBy: order.createdBy ? {
      _id: order.createdBy._id,
      name: isRtl ? order.createdBy.name : (order.createdBy.nameEn || order.createdBy.name || 'Unknown'),
    } : null,
    createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
    approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
    statusHistory: order.statusHistory?.map(history => ({
      status: history.status,
      notes: history.notes || '',
      changedBy: history.changedBy ? {
        _id: history.changedBy._id,
        name: isRtl ? history.changedBy.name : (history.changedBy.nameEn || history.changedBy.name || 'Unknown'),
      } : null,
      changedAt: history.changedAt ? new Date(history.changedAt).toISOString() : null,
    })) || [],
    isRtl,
  };
};

// دالة لإنشاء طلب إنتاج
const createFactoryOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, notes, priority = 'medium' } = req.body;

    // التحقق من صحة البيانات المدخلة
    if (!orderNumber || !items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'رقم الطلب ومصفوفة العناصر مطلوبة' : 'Order number and items array are required',
        error: 'Invalid order number or items',
      });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !Number.isInteger(item.quantity) || item.quantity < 1) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'بيانات العنصر غير صالحة (معرف المنتج، الكمية)' : 'Invalid item data (product ID, quantity)',
          error: 'Invalid item data',
        });
      }
    }

    // دمج العناصر المتكررة
    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        acc.push({
          product: item.product,
          quantity: item.quantity,
          status: 'pending',
          startedAt: null,
          completedAt: null,
        });
      }
      return acc;
    }, []);

    // جلب المنتجات
    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('name nameEn unit unitEn department')
      .populate('department', 'name nameEn code')
      .lean()
      .session(session);

    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found',
        error: 'Products not found',
      });
    }

    // إنشاء طلب جديد
    const newFactoryOrder = new FactoryOrder({
      orderNumber: orderNumber.trim(),
      items: mergedItems,
      status: 'pending',
      notes: notes?.trim() || '',
      priority: priority?.trim() || 'medium',
      createdBy: req.user.id,
      statusHistory: [{
        status: 'pending',
        changedBy: req.user.id,
        notes: notes?.trim() || (isRtl ? 'تم إنشاء طلب إنتاج' : 'Factory order created'),
        changedAt: new Date(),
      }],
    });

    // التحقق من عدم وجود طلب بنفس الرقم
    const existingOrder = await FactoryOrder.findOne({ orderNumber: newFactoryOrder.orderNumber }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'رقم الطلب مستخدم بالفعل' : 'Order number already used',
        error: 'Duplicate order number',
      });
    }

    await newFactoryOrder.save({ session });

    // جلب البيانات المملوءة
    const populatedOrder = await FactoryOrder.findById(newFactoryOrder._id)
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();

    // إشعار المستخدمين
    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
    const eventId = `${newFactoryOrder._id}-factoryOrderCreated`;
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);

    const notificationData = {
      orderId: newFactoryOrder._id,
      orderNumber: newFactoryOrder.orderNumber,
      totalQuantity,
      items: populatedOrder.items.map(item => ({
        productId: item.product?._id,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        quantity: item.quantity,
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      })),
      status: newFactoryOrder.status,
      priority: newFactoryOrder.priority,
      eventId,
      isRtl,
      type: 'persistent',
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers],
      'factoryOrderCreated',
      isRtl ? `تم إنشاء طلب إنتاج رقم ${newFactoryOrder.orderNumber} بكمية ${totalQuantity}` : `Factory order ${newFactoryOrder.orderNumber} created with quantity ${totalQuantity}`,
      notificationData,
      true
    );

    const orderData = formatOrderResponse(populatedOrder, isRtl);

    await emitSocketEvent(io, ['admin', 'production'], 'factoryOrderCreated', { ...orderData, eventId });
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      data: orderData,
      message: isRtl ? 'تم إنشاء طلب الإنتاج بنجاح' : 'Factory order created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating factory order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// دالة محسنة لجلب جميع الطلبات
const getFactoryOrders = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, priority, department } = req.query;

    // بناء استعلام التصفية
    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (department && isValidObjectId(department)) {
      query['items.department'] = department;
    }

    // جلب الطلبات مع تحسين الأداء
    const orders = await FactoryOrder.find(query)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department',
        populate: { path: 'department', select: 'name nameEn code' },
      })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .sort({ createdAt: -1 })
      .lean();

    // التحقق من أن الطلبات تحتوي على بيانات صالحة
    if (!orders || orders.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        message: isRtl ? 'لا توجد طلبات' : 'No orders found',
      });
    }

    // تنسيق الطلبات
    const formattedOrders = orders.map(order => formatOrderResponse(order, isRtl));

    res.status(200).json({
      success: true,
      data: formattedOrders,
      message: isRtl ? 'تم جلب الطلبات بنجاح' : 'Orders fetched successfully',
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory orders:`, {
      error: err.message,
      userId: req.user?.id || 'unknown',
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  }
};

// دالة محسنة لجلب طلب معين
const getFactoryOrderById = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    // التحقق من صحة المعرف
    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
        error: 'Invalid order ID',
      });
    }

    // جلب الطلب مع التأكد من ملء البيانات
    const order = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department',
        populate: { path: 'department', select: 'name nameEn code' },
      })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        error: 'Order not found',
      });
    }

    // تنسيق الطلب
    const formattedOrder = formatOrderResponse(order, isRtl);

    res.status(200).json({
      success: true,
      data: formattedOrder,
      message: isRtl ? 'تم جلب الطلب بنجاح' : 'Order fetched successfully',
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory order by id:`, {
      error: err.message,
      userId: req.user?.id || 'unknown',
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  }
};

// دالة لتعيين الشيفات
const assignFactoryChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { items, notes } = req.body;
    const { id: orderId } = req.params;

    // التحقق من صحة البيانات
    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب أو مصفوفة العناصر غير صالحة' : 'Invalid order ID or items array',
        error: 'Invalid order ID or items',
      });
    }

    // جلب الطلب
    const order = await FactoryOrder.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name nameEn code isActive' } })
      .session(session);

    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        error: 'Order not found',
      });
    }

    // التحقق من حالة الطلب
    if (order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'يجب أن يكون الطلب في حالة "معلق" لتعيين الشيفات' : 'Order must be in "pending" status to assign chefs',
        error: 'Invalid order status',
      });
    }

    // جلب الشيفات
    const chefIds = items.map(item => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));
    const io = req.app.get('io');
    const assignments = [];
    const chefNotifications = [];

    for (const item of items) {
      const itemId = item.itemId;
      if (!isValidObjectId(itemId) || !isValidObjectId(item.assignedTo)) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `معرفات غير صالحة: ${itemId}, ${item.assignedTo}` : `Invalid IDs: ${itemId}, ${item.assignedTo}`,
          error: 'Invalid assignment data',
        });
      }

      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? `العنصر ${itemId} غير موجود` : `Item ${itemId} not found`,
          error: 'Item not found',
        });
      }

      const existingTask = await ProductionAssignment.findOne({ factoryOrder: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'لا يمكن إعادة تعيين المهمة لشيف آخر' : 'Cannot reassign task to another chef',
          error: 'Task already assigned',
        });
      }

      const chef = chefMap.get(item.assignedTo);
      const chefProfile = chefProfileMap.get(item.assignedTo);
      if (!chef || !chefProfile) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: isRtl ? 'الشيف غير صالح' : 'Invalid chef',
          error: 'Invalid chef',
        });
      }

      orderItem.assignedTo = item.assignedTo;
      orderItem.status = 'assigned';
      assignments.push(
        ProductionAssignment.findOneAndUpdate(
          { factoryOrder: orderId, itemId },
          { chef: chefProfile._id, product: orderItem.product, quantity: orderItem.quantity, status: 'pending', itemId, factoryOrder: orderId },
          { upsert: true, session }
        )
      );

      chefNotifications.push({
        userId: item.assignedTo,
        message: isRtl ? `تم تعيينك لإنتاج ${orderItem.product.name} في طلب الإنتاج ${order.orderNumber}` : `Assigned to produce ${orderItem.product.nameEn || orderItem.product.name} for factory order ${order.orderNumber}`,
        data: {
          orderId,
          orderNumber: order.orderNumber,
          taskId: itemId,
          productId: orderItem.product._id,
          productName: isRtl ? orderItem.product.name : (orderItem.product.nameEn || orderItem.product.name),
          quantity: orderItem.quantity,
          eventId: `${itemId}-factory_task_assigned`,
          isRtl,
        },
      });
    }

    await Promise.all(assignments);
    order.markModified('items');
    order.status = 'in_production';
    order.statusHistory.push({
      status: order.status,
      changedBy: req.user.id,
      notes: notes?.trim() || (isRtl ? 'تم تعيين الشيفات' : 'Chefs assigned'),
      changedAt: new Date(),
    });

    await order.save({ session });

    const populatedOrder = await FactoryOrder.findById(orderId)
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();

    const taskAssignedEventData = {
      _id: `${orderId}-factoryTaskAssigned-${Date.now()}`,
      type: 'factoryTaskAssigned',
      message: isRtl ? `تم تعيين الشيفات بنجاح لطلب الإنتاج ${order.orderNumber}` : `Chefs assigned successfully for factory order ${order.orderNumber}`,
      data: {
        orderId,
        orderNumber: order.orderNumber,
        eventId: `${orderId}-factory_task_assigned`,
        isRtl,
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers],
      'factoryTaskAssigned',
      taskAssignedEventData.message,
      taskAssignedEventData.data,
      false
    );

    for (const chefNotif of chefNotifications) {
      await notifyUsers(
        io,
        [{ _id: chefNotif.userId }],
        'factoryTaskAssigned',
        chefNotif.message,
        chefNotif.data,
        false
      );
    }

    const rooms = new Set(['admin', 'production']);
    chefIds.forEach(chefId => rooms.add(`chef-${chefId}`));
    await emitSocketEvent(io, rooms, 'factoryTaskAssigned', taskAssignedEventData);
    await session.commitTransaction();

    res.status(200).json({
      success: true,
      data: formatOrderResponse(populatedOrder, isRtl),
      message: isRtl ? 'تم تعيين الشيفات بنجاح' : 'Chefs assigned successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning factory chefs:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// دالة لتحديث حالة الطلب
const updateFactoryOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
        error: 'Invalid order ID',
      });
    }

    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        error: 'Order not found',
      });
    }

    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` : `Cannot change status from ${order.status} to ${status}`,
        error: 'Invalid status transition',
      });
    }

    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    const populatedOrder = await FactoryOrder.findById(id)
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id role').lean();
    const eventId = `${id}-factory_order_status_updated-${status}`;
    const eventType = status === 'completed' ? 'factoryOrderCompleted' : 'factoryOrderStatusUpdated';
    const messageKey = status === 'completed'
      ? isRtl ? `تم إكمال طلب الإنتاج ${order.orderNumber}` : `Factory order ${order.orderNumber} completed`
      : isRtl ? `تم تحديث حالة طلب الإنتاج ${order.orderNumber} إلى ${status}` : `Factory order ${order.orderNumber} status updated to ${status}`;

    const saveToDb = status === 'completed';
    await notifyUsers(
      io,
      usersToNotify,
      eventType,
      messageKey,
      { orderId: id, orderNumber: order.orderNumber, status, eventId, isRtl },
      saveToDb
    );

    const orderData = {
      orderId: id,
      status,
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      displayNotes: populatedOrder.notes,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production'], eventType, orderData);
    await session.commitTransaction();

    res.status(200).json({
      success: true,
      data: formatOrderResponse(populatedOrder, isRtl),
      message: isRtl ? 'تم تحديث حالة الطلب بنجاح' : 'Order status updated successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating factory order status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

// دالة لتأكيد الإنتاج
const confirmFactoryProduction = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
        error: 'Invalid order ID',
      });
    }

    const order = await FactoryOrder.findById(id).populate('items.product').session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الطلب غير موجود' : 'Order not found',
        error: 'Order not found',
      });
    }

    if (req.user.role !== 'production' && req.user.role !== 'admin') {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لتأكيد الإنتاج' : 'Unauthorized to confirm production',
        error: 'Unauthorized',
      });
    }

    if (order.status !== 'in_production') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'يجب أن يكون الطلب في حالة "قيد الإنتاج"' : 'Order must be in "in_production" status',
        error: 'Invalid order status',
      });
    }

    if (!order.items.every(i => i.status === 'completed')) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'يجب إكمال جميع العناصر' : 'All items must be completed',
        error: 'Items not completed',
      });
    }

    for (const item of order.items) {
      const inventoryUpdate = await FactoryInventory.findOneAndUpdate(
        { product: item.product },
        {
          $inc: { currentStock: item.quantity },
          $push: {
            movements: {
              type: 'in',
              quantity: item.quantity,
              reference: `تأكيد إنتاج طلب #${order.orderNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { new: true, upsert: true, session }
      );

      const historyEntry = new FactoryInventoryHistory({
        product: item.product,
        action: 'produced_stock',
        quantity: item.quantity,
        reference: `تأكيد إنتاج طلب #${order.orderNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }

    order.status = 'completed';
    order.statusHistory.push({
      status: 'completed',
      changedBy: req.user.id,
      notes: isRtl ? 'تم تأكيد الإنتاج' : 'Production confirmed',
      changedAt: new Date(),
    });

    await order.save({ session });

    const populatedOrder = await FactoryOrder.findById(id)
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn' })
      .populate('createdBy', 'username name nameEn')
      .session(session)
      .lean();

    const io = req.app.get('io');
    const usersToNotify = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id role').lean();
    const eventId = `${id}-factory_order_completed`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      status: 'completed',
      eventId,
      isRtl,
    };

    await notifyUsers(
      io,
      usersToNotify,
      'factoryOrderCompleted',
      isRtl ? `تم إكمال طلب الإنتاج ${order.orderNumber}` : `Factory order ${order.orderNumber} completed`,
      eventData,
      true
    );

    const orderData = {
      orderId: id,
      orderNumber: order.orderNumber,
      status: 'completed',
      items: populatedOrder.items,
      completedAt: new Date().toISOString(),
      eventId,
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production'], 'factoryOrderCompleted', orderData);
    await session.commitTransaction();

    res.status(200).json({
      success: true,
      data: formatOrderResponse(populatedOrder, isRtl),
      message: isRtl ? 'تم تأكيد الإنتاج بنجاح' : 'Production confirmed successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming factory production:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createFactoryOrder,
  getFactoryOrders,
  getFactoryOrderById,
  assignFactoryChefs,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
};