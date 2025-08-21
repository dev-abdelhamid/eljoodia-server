const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  rooms.forEach(room => io.of('/api').to(room).emit(eventName, eventData));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, {
    rooms,
    eventData: { ...eventData, sound: eventData.sound, vibrate: eventData.vibrate }
  });
};

const notifyUsers = async (io, users, type, message, data) => {
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, { users: users.map(u => u._id), message, data });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err);
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) ||
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' });
    }

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

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
    }

    const productDoc = await Product.findById(product).populate('department').session(session);
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

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

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefProfile._id,
      quantity,
      itemId,
      status: 'pending'
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chef;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .populate('chef', 'user')
      .lean();

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: (await mongoose.model('Branch').findById(orderDoc.branch).select('name').lean())?.name || 'Unknown',
      itemId,
      sound: '/task-assigned.mp3',
      vibrate: [400, 100, 400]
    };
    await emitSocketEvent(io, [`chef-${chef}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent);
    await notifyUsers(io, [{ _id: chef }], 'task_assigned',
      `تم تعيينك لإنتاج ${productDoc.name} في الطلب ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch }
    );

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

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
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

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المهمة غير صالح' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session);
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

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث هذه المهمة' });
    }

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

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status} by user ${req.user.id}`);

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

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

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date()
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'in_production'`);
      const usersToNotify = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branchId: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'order_status_updated',
        `بدأ إنتاج الطلب ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch }
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        sound: '/notification.mp3',
        vibrate: [200, 100, 200]
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', orderStatusUpdatedEvent);
    }

    await order.save({ session });

    await syncOrderTasks(orderId, io, session);

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber')
      .populate({
        path: 'product',
        select: 'name department',
        populate: { path: 'department', select: 'name code' }
      })
      .populate('chef', 'user')
      .lean();

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
      itemId: task.itemId,
      sound: '/status-updated.mp3',
      vibrate: [200, 100, 200]
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskStatusUpdated', taskStatusUpdatedEvent);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: (await mongoose.model('Branch').findById(order.branch).select('name').lean())?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
        sound: '/notification.mp3',
        vibrate: [200, 100, 200]
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, `branch-${order.branch}`, 'admin', 'production'], 'taskCompleted', taskCompletedEvent);
      await notifyUsers(io, [{ _id: task.chef._id }], 'task_completed',
        `تم إكمال مهمة للطلب ${task.order.orderNumber}`,
        { taskId, orderId, orderNumber: task.order.orderNumber, branchId: order.branch }
      );
    }

    res.status(200).json({ success: true, task: populatedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session = null) => {
  try {
    console.log(`[${new Date().toISOString()}] Starting syncOrderTasks for order ${orderId}`);
    
    // Fetch order and populate items
    const order = await Order.findById(orderId)
      .populate('items.product')
      .populate('branch', 'name')
      .session(session);
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found for sync: ${orderId}`);
      throw new Error(`Order ${orderId} not found`);
    }

    // Fetch tasks associated with the order
    const tasks = await ProductionAssignment.find({ order: orderId })
      .populate('product', 'name department')
      .populate('chef', 'user')
      .lean();
    
    console.log(`[${new Date().toISOString()}] Found ${tasks.length} tasks for order ${orderId}`);

    // Create a map of task statuses by itemId for efficient lookup
    const taskMap = new Map(tasks.map(task => [task.itemId?.toString(), task]));

    // Track whether all items are completed
    let allItemsCompleted = true;
    const itemStatusUpdates = [];

    // Sync each order item with its corresponding task
    for (const item of order.items) {
      if (!item._id) {
        console.error(`[${new Date().toISOString()}] Invalid item in order ${orderId}: No _id found`, item);
        continue;
      }

      const task = taskMap.get(item._id.toString());
      if (!task) {
        // Item has no corresponding task
        console.warn(`[${new Date().toISOString()}] No task found for item ${item._id} in order ${orderId}`);
        if (item.status !== 'pending') {
          console.log(`[${new Date().toISOString()}] Setting item ${item._id} status to 'pending' due to missing task`);
          item.status = 'pending';
          item.startedAt = null;
          item.completedAt = null;
          itemStatusUpdates.push({
            itemId: item._id,
            status: 'pending',
            productName: item.product?.name || 'Unknown',
            branchId: order.branch?._id,
            branchName: order.branch?.name || 'Unknown',
            orderNumber: order.orderNumber
          });
        }
        allItemsCompleted = false;
        continue;
      }

      // Validate task itemId matches order item
      if (task.itemId.toString() !== item._id.toString()) {
        console.error(`[${new Date().toISOString()}] Task ${task._id} itemId ${task.itemId} does not match order item ${item._id}`);
        allItemsCompleted = false;
        continue;
      }

      // Update item status to match task status
      if (item.status !== task.status) {
        console.log(`[${new Date().toISOString()}] Syncing item ${item._id} status from ${item.status} to ${task.status}`);
        item.status = task.status;
        if (task.status === 'in_progress') {
          item.startedAt = task.startedAt || new Date();
        } else if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        } else {
          item.startedAt = null;
          item.completedAt = null;
        }
        itemStatusUpdates.push({
          itemId: item._id,
          status: task.status,
          productName: item.product?.name || 'Unknown',
          branchId: order.branch?._id,
          branchName: order.branch?.name || 'Unknown',
          orderNumber: order.orderNumber
        });
      }

      if (task.status !== 'completed') {
        allItemsCompleted = false;
      }
    }

    // Mark items as modified
    order.markModified('items');

    // Update order status if all items are completed
    if (allItemsCompleted && order.status !== 'completed' && order.status !== 'in_transit' && order.status !== 'delivered') {
      console.log(`[${new Date().toISOString()}] Completing order ${orderId}: all items completed`);
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date(),
      });
      console.log(`[${new Date().toISOString()}] Added statusHistory entry for order ${orderId}:`, {
        status: 'completed',
        changedBy: 'system',
        changedAt: new Date().toISOString()
      });
    } else {
      console.log(`[${new Date().toISOString()}] Order ${orderId} not completed:`, {
        allItemsCompleted,
        currentOrderStatus: order.status,
        incompleteItems: order.items
          .filter(i => i.status !== 'completed')
          .map(i => ({ id: i._id, status: i.status, product: i.product?.name }))
      });
    }

    // Save the updated order
    await order.save({ session });
    console.log(`[${new Date().toISOString()}] Saved updated order ${orderId}`);

    // Emit socket events for item status updates
    for (const update of itemStatusUpdates) {
      const itemStatusEvent = {
        orderId,
        itemId: update.itemId,
        status: update.status,
        orderNumber: update.orderNumber,
        branchId: update.branchId,
        branchName: update.branchName,
        productName: update.productName,
        sound: update.status === 'completed' ? '/item-completed.mp3' : '/status-updated.mp3',
        vibrate: [200, 100, 200]
      };
      await emitSocketEvent(io, [`branch-${update.branchId}`, 'production', 'admin'], 'itemStatusUpdated', itemStatusEvent);
      console.log(`[${new Date().toISOString()}] Emitted itemStatusUpdated for item ${update.itemId}:`, itemStatusEvent);
    }

    // Emit order completion event if applicable
    if (allItemsCompleted && order.status === 'completed') {
      const branch = await mongoose.model('Branch').findById(order.branch).select('name').lean();
      const usersToNotify = await User.find({ 
        role: { $in: ['branch', 'admin', 'production'] }, 
        branchId: order.branch 
      }).select('_id').lean();

      await notifyUsers(io, usersToNotify, 'order_completed',
        `تم اكتمال الطلب ${order.orderNumber} لفرع ${branch?.name || 'Unknown'}`,
        { 
          orderId, 
          orderNumber: order.orderNumber, 
          branchId: order.branch, 
          branchName: branch?.name || 'Unknown' 
        }
      );

      const orderCompletedEvent = {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: branch?.name || 'Unknown',
        completedAt: new Date().toISOString(),
        sound: '/order-completed.mp3',
        vibrate: [300, 100, 300]
      };
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderCompleted', orderCompletedEvent);
      await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', {
        ...orderCompletedEvent,
        status: 'completed',
        user: { id: 'system' }
      });
      console.log(`[${new Date().toISOString()}] Emitted orderCompleted for order ${orderId}`);
    }

    // Notify about missing tasks
    const missingItems = order.items.filter(item => !taskMap.has(item._id.toString()) && item.status !== 'completed');
    if (missingItems.length > 0) {
      console.warn(`[${new Date().toISOString()}] Missing assignments for order ${orderId}:`, 
        missingItems.map(i => ({ id: i._id, product: i.product?.name })));
      
      for (const item of missingItems) {
        const product = await Product.findById(item.product).lean();
        if (!product) {
          console.warn(`[${new Date().toISOString()}] Product not found for item ${item._id}: ${item.product}`);
          continue;
        }
        await emitSocketEvent(io, ['production', 'admin', `branch-${order.branch}`], 'missingAssignments', {
          orderId,
          itemId: item._id,
          productId: product._id,
          productName: product.name,
          sound: '/notification.mp3',
          vibrate: [400, 100, 400]
        });
      }
    }

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in syncOrderTasks for order ${orderId}:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };
```

### Explanation of Changes

The updated `productionController.js` includes the following improvements:

1. **Enhanced `syncOrderTasks`**:
   - **Task-Item Mapping**: Uses a `Map` to efficiently match tasks to order items by `itemId`.
   - **Status Synchronization**: Updates each item’s status to match its task’s status, setting `pending` for items without tasks.
   - **Validation**: Ensures `task.itemId` matches `order.items._id` to prevent mismatches.
   - **Socket Events**: Emits `itemStatusUpdated` events for each item status change, enabling real-time frontend updates.
   - **Order Completion**: Marks the order as `completed` only when all items are `completed`, with detailed logging for incomplete items.
   - **Missing Tasks**: Identifies items without tasks, sets them to `pending`, and emits `missingAssignments` events.

2. **Improved `createTask`**:
   - Validates that `itemId` corresponds to a valid order item and matches the provided `product`.
   - Ensures `orderDoc.save()` is called before `syncOrderTasks` to persist item status changes (`assigned`).

3. **Robust `updateTaskStatus`**:
   - Logs the user ID performing the update for better traceability.
   - Validates that the task’s `itemId` exists in the order and updates the corresponding item’s status.
   - Calls `syncOrderTasks` to ensure order-level consistency after task updates.

4. **Error Handling and Logging**:
   - Comprehensive logging for debugging, including task and item statuses, missing tasks, and invalid references.
   - Throws errors for critical failures, ensuring transactions are rolled back cleanly.

5. **Socket Event Consistency**:
   - Ensures consistent event emission (`taskAssigned`, `taskStatusUpdated`, `taskCompleted`, `itemStatusUpdated`, `orderCompleted`, `orderStatusUpdated`) across all functions.
   - Includes `branchName` and `productName` in events for better frontend display.

### Integration with Frontend

To ensure the frontend (`BranchOrders.tsx`) reflects these changes, you need to update it to handle the new `itemStatusUpdated` event. Below is the relevant snippet for the socket event handling in `BranchOrders.tsx`, as provided previously, for completeness:

<xaiArtifact artifact_id="b46f6eb7-879c-4bd6-b74f-2298c9928974" artifact_version_id="b1bd40b3-cf2c-4cc9-97b4-23ec38dcb3ce" title="BranchOrders.tsx (Socket Update)" contentType="text/typescript">
```typescript
// Inside the socket useEffect in BranchOrders.tsx
useEffect(() => {
  if (!user?.branchId || !socket) return;

  const handleConnect = () => {
    socket.emit('joinRoom', { role: user.role, branchId: user.branchId, userId: user.id });
    dispatch({ type: 'SET_SOCKET_CONNECTED', payload: true });
    dispatch({ type: 'ADD_TOAST', payload: { id: `success-${Date.now()}`, message: t('socket.connected'), type: 'success' } });
  };

  const handleConnectError = (err: any) => {
    console.error('Socket connection error:', err);
    dispatch({ type: 'SET_SOCKET_CONNECTED', payload: false });
    dispatch({ type: 'ADD_TOAST', payload: { id: `error-${Date.now()}`, message: t('errors.socket_connection_failed'), type: 'error' } });
  };

  const handleOrderCreated = ({ orderId, branchId, orderNumber }: { orderId: string; branchId: string; orderNumber: string }) => {
    if (user.role !== 'branch' || branchId !== user.branchId) return;
    dispatch({ type: 'ADD_TOAST', payload: { id: `success-${Date.now()}`, message: t('orders.order_created', { orderNumber }), type: 'success' } });
    fetchData();
  };

  const handleOrderStatusUpdated = ({ orderId, status }: { orderId: string; status: string }) => {
    if (user.role !== 'branch') return;
    dispatch({ type: 'UPDATE_ORDER_STATUS', orderId, status: status as Order['status'] });
    if (state.selectedOrder?.id === orderId) {
      dispatch({ type: 'ADD_TOAST', payload: { id: `success-${Date.now()}`, message: t('orders.orderStatusUpdated', { status: t(`orders.status.${status}`) }), type: 'success' } });
    }
  };

  const handleItemStatusUpdated = ({ orderId, itemId, status, productName }: { orderId: string; itemId: string; status: string; productName: string }) => {
    if (user.role !== 'branch') return;
    dispatch({
      type: 'UPDATE_ITEM_STATUS',
      payload: { orderId, itemId, status: status as Order['items'][0]['status'] }
    });
    dispatch({
      type: 'ADD_TOAST',
      payload: {
        id: `success-${Date.now()}`,
        message: t('orders.itemStatusUpdated', { productName, status: t(`orders.status.${status}`) }),
        type: 'success'
      }
    });
  };

  const handleInventoryUpdated = ({ branchId }: { branchId: string }) => {
    if (branchId === user.branchId) fetchData();
  };

  const handleReturnCreated = ({ branchId, orderId, returnData }: { branchId: string; orderId: string; returnData: any }) => {
    if (user.role !== 'branch' || branchId !== user.branchId) return;
    const newReturn = {
      returnId: returnData._id || 'unknown',
      items: (returnData.items || []).map((item: any) => ({
        product: item.product || 'unknown',
        quantity: item.quantity || 0,
        reason: item.reason || 'unknown',
        status: returnData.status || 'pending',
      })),
      status: returnData.status || 'pending',
      createdAt: formatDate(returnData.createdAt || Date.now()),
    };
    dispatch({ type: 'ADD_RETURN', orderId, returnData: newReturn });
    dispatch({ type: 'ADD_TOAST', payload: { id: `success-${Date.now()}`, message: t('orders.return_submitted'), type: 'success' } });
  };

  const handleReturnStatusUpdated = ({ orderId, status, returnId }: { orderId: string; status: string; returnId: string }) => {
    if (user.role !== 'branch') return;
    dispatch({
      type: 'SET_ORDERS',
      payload: state.orders.map((o) =>
        o.id === orderId
          ? {
              ...o,
              returns: o.returns?.map((r) => (r.returnId === returnId ? { ...r, status } : r)) || [],
              total: status === 'approved'
                ? o.total - (o.returns?.find((r) => r.returnId === returnId)?.items.reduce((sum, item) => {
                    const orderItem = o.items.find((i) => i.productId === item.product);
                    return sum + (orderItem ? orderItem.price * item.quantity : 0);
                  }, 0) || 0)
                : o.total,
            }
          : o
      ),
    });
    if (state.selectedOrder?.id === orderId) {
      dispatch({
        type: 'SET_SELECTED_ORDER',
        payload: {
          ...state.selectedOrder,
          returns: state.selectedOrder.returns?.map((r) => (r.returnId === returnId ? { ...r, status } : r)) || [],
          total: status === 'approved'
            ? state.selectedOrder.total - (state.selectedOrder.returns?.find((r) => r.returnId === returnId)?.items.reduce((sum, item) => {
                const orderItem = state.selectedOrder.items.find((i) => i.productId === item.product);
                return sum + (orderItem ? orderItem.price * item.quantity : 0);
              }, 0) || 0)
            : state.selectedOrder.total,
        },
      });
    }
    dispatch({ type: 'ADD_TOAST', payload: { id: `success-${Date.now()}`, message: t('orders.returnStatusUpdated', { status: t(`orders.return_status.${status}`) }), type: 'success' } });
  };

  socket.on('connect', handleConnect);
  socket.on('connect_error', handleConnectError);
  socket.on('orderCreated', handleOrderCreated);
  socket.on('orderStatusUpdated', handleOrderStatusUpdated);
  socket.on('itemStatusUpdated', handleItemStatusUpdated);
  socket.on('inventoryUpdated', handleInventoryUpdated);
  socket.on('returnCreated', handleReturnCreated);
  socket.on('returnStatusUpdated', handleReturnStatusUpdated);
  socket.on('taskAssigned', () => {});
  socket.on('taskStatusUpdated', () => {});

  return () => {
    socket.off('connect', handleConnect);
    socket.off('connect_error', handleConnectError);
    socket.off('orderCreated', handleOrderCreated);
    socket.off('orderStatusUpdated', handleOrderStatusUpdated);
    socket.off('itemStatusUpdated', handleItemStatusUpdated);
    socket.off('inventoryUpdated', handleInventoryUpdated);
    socket.off('returnCreated', handleReturnCreated);
    socket.off('returnStatusUpdated', handleReturnStatusUpdated);
    socket.off('taskAssigned');
    socket.off('taskStatusUpdated');
    socket.disconnect();
  };
}, [socket, user, state.selectedOrder, t, formatDate, fetchData]);
```

### Reducer Update for `BranchOrders.tsx`

Add the `UPDATE_ITEM_STATUS` action to the reducer to handle item status updates:

<xaiArtifact artifact_id="ac551a47-a22f-4bf5-9334-7482ef02eea9" artifact_version_id="3292143f-2ab0-43ea-96f9-9fe29571aa3e" title="BranchOrders.tsx (Updated Reducer)" contentType="text/typescript">
```typescript
type Action =
  // ... existing actions ...
  | {
      type: 'UPDATE_ITEM_STATUS';
      payload: { orderId: string; itemId: string; status: Order['items'][0]['status'] };
    };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    // ... existing cases ...
    case 'UPDATE_ITEM_STATUS':
      return {
        ...state,
        orders: state.orders.map((o) =>
          o.id === action.payload.orderId
            ? {
                ...o,
                items: o.items.map((i) =>
                  i.itemId === action.payload.itemId ? { ...i, status: action.payload.status } : i
                ),
              }
            : o
        ),
        selectedOrder: state.selectedOrder?.id === action.payload.orderId
          ? {
              ...state.selectedOrder,
              items: state.selectedOrder.items.map((i) =>
                i.itemId === action.payload.itemId ? { ...i, status: action.payload.status } : i
              ),
            }
          : state.selectedOrder,
      };
    default:
      return state;
  }
};
```

### Translation Updates

Ensure the translation file includes entries for `itemStatusUpdated`:

```json
{
  "orders": {
    "itemStatusUpdated": "تم تحديث حالة العنصر {productName} إلى {status}",
    "status": {
      "pending": "معلق",
      "assigned": "تم التعيين",
      "in_progress": "قيد التقدم",
      "completed": "مكتمل"
    }
  }
}
```

### Additional Recommendations

1. **Add a Sync Endpoint**:
   - To handle cases where orders get stuck, add an endpoint to manually trigger `syncOrderTasks`:
     ```javascript
     const syncOrder = async (req, res) => {
       const session = await mongoose.startSession();
       try {
         session.startTransaction();
         const { id } = req.params;
         if (!mongoose.isValidObjectId(id)) {
           await session.abortTransaction();
           return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
         }
         await syncOrderTasks(id, req.app.get('io'), session);
         await session.commitTransaction();
         res.status(200).json({ success: true, message: `تمت مزامنة الطلب ${id} بنجاح` });
       } catch (err) {
         await session.abortTransaction();
         console.error(`[${new Date().toISOString()}] Error syncing order:`, err);
         res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
       } finally {
         session.endSession();
       }
     };
     // Add to exports in ordersController.js
     module.exports = { createOrder, assignChefs, getOrders, getOrderById, approveOrder, startTransit, updateOrderStatus, confirmDelivery, approveReturn, syncOrder };
