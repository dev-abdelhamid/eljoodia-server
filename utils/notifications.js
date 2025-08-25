const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');

const SOUND_PATH = '/sounds/notification.mp3';
const VIBRATE_PATTERN = [200, 100, 200];

async function createNotification(userId, type, message, data = {}, io) {
  try {
    if (!mongoose.isValidObjectId(userId)) throw new Error(`معرف المستخدم غير صالح: ${userId}`);
    
    const validTypes = [
      'new_order_from_branch', 'branch_confirmed_receipt', 'new_order_for_production',
      'order_completed_by_chefs', 'order_approved_for_branch', 'order_in_transit_to_branch',
      'new_production_assigned_to_chef', 'order_status_updated', 'task_assigned',
      'order_completed', 'order_delivered', 'return_status_updated', 'missing_assignments'
    ];
    if (!validTypes.includes(type)) throw new Error(`نوع الإشعار غير صالح: ${type}`);

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name')
      .populate('department', 'name')
      .lean();
    if (!targetUser) throw new Error('المستخدم غير موجود');

    const notification = new Notification({
      user: userId,
      type,
      message: message.trim(),
      data,
      read: false,
      createdAt: new Date(),
    });
    await notification.save();

    const eventData = {
      _id: notification._id.toString(),
      type: notification.type,
      message: notification.message,
      data: {
        ...notification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        branchName: targetUser.branch?.name,
      },
      read: notification.read,
      createdAt: notification.createdAt.toISOString(),
      sound: SOUND_PATH,
      vibrate: VIBRATE_PATTERN,
      timestamp: new Date().toISOString(),
    };

    const rooms = getRoomsForUser(targetUser, data);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    return notification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء الإشعار:`, err);
    throw err;
  }
}

function getRoomsForUser(user, data = {}) {
  const rooms = [`user-${user._id}`];
  if (user.role) rooms.push(user.role);
  if (user.branch?._id) rooms.push(`branch-${user.branch._id}`);
  if (user.department?._id) rooms.push(`department-${user.department._id}`);
  if (data.chefId) rooms.push(`chef-${data.chefId}`);
  if (data.branchId) rooms.push(`branch-${data.branchId}`);
  if (data.departmentId) rooms.push(`department-${data.departmentId}`);
  rooms.push('all-departments');
  return [...new Set(rooms)];
}

async function getUsersToNotify(roles = [], branchId = null, extraQuery = {}) {
  const query = { $or: [] };
  const globalRoles = roles.filter(r => r !== 'branch');
  if (globalRoles.length) query.$or.push({ role: { $in: globalRoles } });
  if (roles.includes('branch') && branchId) query.$or.push({ role: 'branch', branch: branchId });
  if (Object.keys(extraQuery).length) query.$or.push(extraQuery);
  if (!query.$or.length) return [];
  return await User.find(query).select('_id').lean();
}

function getRooms(roles = [], branchId = null, extraRooms = []) {
  const rooms = [];
  roles.forEach(role => {
    if (role !== 'branch') rooms.push(role);
    if (role === 'branch' && branchId) rooms.push(`branch-${branchId}`);
  });
  return [...new Set([...rooms, ...extraRooms])];
}

async function notifyUsers(io, users, type, message, data) {
  const promises = users.map(user => createNotification(user._id, type, message, data, io));
  await Promise.all(promises);
}

function emitSocketEvent(io, rooms, eventName, eventData) {
  const eventDataWithSound = {
    ...eventData,
    sound: SOUND_PATH,
    vibrate: VIBRATE_PATTERN,
  };
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] أُرسل الحدث ${eventName} إلى الغرف: ${rooms.join(', ')}`);
}

function setupNotifications(io, socket) {
  socket.on('orderCreated', async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;

    const eventData = {
      _id: `${orderId}-orderCreated-${Date.now()}`,
      type: 'new_order_from_branch',
      message: `طلب جديد ${orderNumber} من ${order.branch?.name || 'غير معروف'}`,
      data: { orderId, branchId },
      read: false,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    const rooms = getRooms(['admin', 'production'], branchId, ['all-departments']);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    const users = await getUsersToNotify(['admin', 'production', 'branch'], branchId);
    await notifyUsers(io, users, 'new_order_from_branch', eventData.message, eventData.data);
  });

  socket.on('orderApproved', async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;

    const eventData = {
      _id: `${orderId}-orderApproved-${Date.now()}`,
      type: 'order_approved_for_branch',
      message: `تم اعتماد الطلب ${orderNumber} لـ ${order.branch?.name || 'غير معروف'}`,
      data: { orderId, branchId },
      read: false,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    const rooms = getRooms(['admin', 'production', 'branch'], branchId, ['all-departments']);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    const users = await getUsersToNotify(['admin', 'production', 'branch'], branchId);
    await notifyUsers(io, users, 'order_approved_for_branch', eventData.message, eventData.data);
  });

  socket.on('taskAssigned', async (data) => {
    const { orderId, taskId, chefId, productId, productName, quantity, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;

    const eventData = {
      _id: `${orderId}-taskAssigned-${Date.now()}`,
      type: 'new_production_assigned_to_chef',
      message: `تم تعيين مهمة جديدة للطلب ${order.orderNumber || 'غير معروف'}`,
      data: { orderId, taskId, branchId: order.branch?._id || branchId, chefId, productId, productName, quantity },
      read: false,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    const rooms = getRooms(['admin', 'production'], branchId, [`chef-${chefId}`, 'all-departments']);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    const users = await getUsersToNotify(['admin', 'production', 'branch'], branchId, { _id: chefId });
    await notifyUsers(io, users, 'new_production_assigned_to_chef', eventData.message, eventData.data);
  });

  socket.on('taskCompleted', async (data) => {
    const { orderId, taskId, chefId, productName } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;

    const eventData = {
      _id: `${orderId}-taskCompleted-${Date.now()}`,
      type: 'order_completed_by_chefs',
      message: `تم إكمال المهمة (${productName || 'غير معروف'}) للطلب ${order.orderNumber || 'غير معروف'}`,
      data: { orderId, taskId, branchId: order.branch?._id, chefId },
      read: false,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    const rooms = getRooms(['admin', 'production'], order.branch?._id, [`chef-${chefId}`, 'all-departments']);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    const users = await getUsersToNotify(['admin', 'production', 'branch'], order.branch?._id);
    await notifyUsers(io, users, 'order_completed_by_chefs', eventData.message, eventData.data);
  });

  socket.on('branchConfirmed', async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;

    const eventData = {
      _id: `${orderId}-branchConfirmed-${Date.now()}`,
      type: 'branch_confirmed_receipt',
      message: `تم تأكيد استلام الطلب ${orderNumber} بواسطة ${order.branch?.name || 'غير معروف'}`,
      data: { orderId, branchId },
      read: false,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    const rooms = getRooms(['admin', 'production', 'branch'], branchId, ['all-departments']);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    const users = await getUsersToNotify(['admin', 'production', 'branch'], branchId);
    await notifyUsers(io, users, 'branch_confirmed_receipt', eventData.message, eventData.data);
  });

  socket.on('orderInTransit', async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;

    const eventData = {
      _id: `${orderId}-orderInTransit-${Date.now()}`,
      type: 'order_in_transit_to_branch',
      message: `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'غير معروف'}`,
      data: { orderId, branchId },
      read: false,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    const rooms = getRooms(['admin', 'production', 'branch'], branchId, ['all-departments']);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    const users = await getUsersToNotify(['admin', 'production', 'branch'], branchId);
    await notifyUsers(io, users, 'order_in_transit_to_branch', eventData.message, eventData.data);
  });

  socket.on('orderDelivered', async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const order = await Order.findById(orderId).populate('branch', 'name').lean();
    if (!order) return;

    const eventData = {
      _id: `${orderId}-orderDelivered-${Date.now()}`,
      type: 'order_delivered',
      message: `تم تسليم الطلب ${orderNumber} إلى ${order.branch?.name || 'غير معروف'}`,
      data: { orderId, branchId },
      read: false,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    const rooms = getRooms(['admin', 'production', 'branch'], branchId, ['all-departments']);
    emitSocketEvent(io, rooms, 'newNotification', eventData);

    const users = await getUsersToNotify(['admin', 'production', 'branch'], branchId);
    await notifyUsers(io, users, 'order_delivered', eventData.message, eventData.data);
  });
}

module.exports = { createNotification, notifyUsers, emitSocketEvent, getUsersToNotify, getRooms, setupNotifications };