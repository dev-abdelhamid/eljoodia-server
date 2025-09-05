const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { createNotification } = require('../utils/notifications');
const { emitSocketEvent } = require('./productionController');

const checkOrderExists = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    res.status(200).json({ success: true, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { items, branchId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(branchId) || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createOrder:`, { branchId, items });
      return res.status(400).json({ success: false, message: 'معرف الفرع وتفاصيل العناصر مطلوبة' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Branch not found: ${branchId}`);
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    const validItems = [];
    for (const item of items) {
      if (!mongoose.isValidObjectId(item.product) || !item.quantity || item.quantity < 1) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid item in order:`, item);
        return res.status(400).json({ success: false, message: 'تفاصيل العنصر غير صالحة' });
      }
      const product = await Product.findById(item.product).session(session);
      if (!product) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Product not found: ${item.product}`);
        return res.status(404).json({ success: false, message: `المنتج ${item.product} غير موجود` });
      }
      validItems.push({
        product: item.product,
        quantity: item.quantity,
        status: 'pending',
      });
    }

    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const newOrder = new Order({
      orderNumber,
      branch: branchId,
      items: validItems,
      status: 'pending',
      statusHistory: [{
        status: 'pending',
        changedBy: req.user.id,
        changedAt: new Date(),
      }],
    });

    await newOrder.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const orderCreatedEvent = {
      orderId: newOrder._id,
      orderNumber,
      branchId,
      branchName: branch.name || 'Unknown',
      items: populatedOrder.items,
    };
    await emitSocketEvent(io, ['admin', 'production'], 'orderCreated', orderCreatedEvent);

    const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean();
    await notifyUsers(io, users, 'new_order_from_branch',
      `طلب جديد ${orderNumber} من ${branch.name || 'غير معروف'}`,
      { orderId: newOrder._id, orderNumber, branchId }
    );

    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    let query = {};
    if (req.user.role === 'branch') {
      query.branch = req.user.branchId;
    }

    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate('items.product', 'name department')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(orders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name department')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    res.status(200).json(order);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { items, reason } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id) || !Array.isArray(items) || !reason) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createReturn:`, { id, items, reason });
      return res.status(400).json({ success: false, message: 'معرف الطلب، العناصر، والسبب مطلوبة' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const validReturnItems = [];
    for (const item of items) {
      const orderItem = order.items.id(item.itemId);
      if (!orderItem || item.quantity < 1 || item.quantity > orderItem.quantity) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid return item:`, { itemId: item.itemId, quantity: item.quantity });
        return res.status(400).json({ success: false, message: `العنصر ${item.itemId} غير صالح أو الكمية غير صحيحة` });
      }
      validReturnItems.push({
        itemId: item.itemId,
        quantity: item.quantity,
        reason: item.reason || reason,
      });
    }

    order.returns = order.returns || [];
    order.returns.push({
      items: validReturnItems,
      reason,
      status: 'pending',
      createdBy: req.user.id,
      createdAt: new Date(),
    });

    await order.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const returnCreatedEvent = {
      orderId: id,
      returnId: order.returns[order.returns.length - 1]._id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, ['admin', 'production'], 'returnCreated', returnCreatedEvent);

    const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean();
    await notifyUsers(io, users, 'return_status_updated',
      `طلب إرجاع جديد للطلب ${order.orderNumber} من ${populatedOrder.branch?.name || 'غير معروف'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(201).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id, returnId } = req.params;
    const { status } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(returnId) || !['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for approveReturn:`, { id, returnId, status });
      return res.status(400).json({ success: false, message: 'معرف الطلب، معرف الإرجاع، أو الحالة غير صالحة' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    const returnRequest = order.returns.id(returnId);
    if (!returnRequest) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Return not found: ${returnId}`);
      return res.status(404).json({ success: false, message: 'طلب الإرجاع غير موجود' });
    }

    returnRequest.status = status;
    returnRequest.approvedBy = req.user.id;
    returnRequest.approvedAt = new Date();

    await order.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const returnStatusEvent = {
      orderId: id,
      returnId,
      status,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'returnStatusUpdated', returnStatusEvent);

    const users = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();
    await notifyUsers(io, users, 'return_status_updated',
      `تم ${status === 'approved' ? 'الموافقة' : 'رفض'} طلب إرجاع للطلب ${order.orderNumber}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving return:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { assignments } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id) || !Array.isArray(assignments)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for assignChefs:`, { id, assignments });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو التعيينات غير صالحة' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    for (const assignment of assignments) {
      const { product, chef, quantity, itemId } = assignment;
      if (!mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 || !mongoose.isValidObjectId(itemId)) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid assignment:`, { product, chef, quantity, itemId });
        return res.status(400).json({ success: false, message: 'تفاصيل التعيين غير صالحة' });
      }

      const productDoc = await Product.findById(product).populate('department').session(session);
      if (!productDoc) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
        return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
      }

      const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
      const chefDoc = await User.findById(chef).populate('department').session(session);
      if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile || chefDoc.department._id.toString() !== productDoc.department._id.toString()) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
          chefId: chef,
          chefRole: chefDoc?.role,
          chefDepartment: chefDoc?.department?._id,
          productDepartment: productDoc.department._id,
        });
        return res.status(400).json({ success: false, message: 'الشيف غير صالح أو غير متطابق مع قسم المنتج' });
      }

      const orderItem = order.items.id(itemId);
      if (!orderItem || orderItem.product.toString() !== product) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
        return res.status(400).json({ success: false, message: `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` });
      }

      const newAssignment = new mongoose.model('ProductionAssignment')({
        order: id,
        product,
        chef: chefProfile._id,
        quantity,
        itemId,
        status: 'pending',
      });
      await newAssignment.save({ session });

      orderItem.status = 'assigned';
      orderItem.assignedTo = chef;
      orderItem.department = productDoc.department._id;
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(id, io, session);

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const assignmentsCreatedEvent = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'chefsAssigned', assignmentsCreatedEvent);

    const users = await User.find({ _id: { $in: assignments.map(a => a.chef) } }).select('_id').lean();
    await notifyUsers(io, users, 'task_assigned',
      `تم تعيينك لإنتاج عناصر في الطلب ${order.orderNumber}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'pending') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${id} not in pending status`);
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة الانتظار' });
    }

    order.status = 'approved';
    order.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const orderApprovedEvent = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderApproved', orderApprovedEvent);

    const users = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();
    await notifyUsers(io, users, 'order_approved_for_branch',
      `تم اعتماد الطلب ${order.orderNumber} لـ ${populatedOrder.branch?.name || 'غير معروف'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const startTransit = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${id} not in approved status`);
      return res.status(400).json({ success: false, message: 'يجب الموافقة على الطلب قبل بدء الشحن' });
    }

    order.status = 'in_transit';
    order.statusHistory.push({
      status: 'in_transit',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const orderShippedEvent = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderShipped', orderShippedEvent);

    const users = await User.find({ role: 'branch', branch: order.branch }).select('_id').lean();
    await notifyUsers(io, users, 'order_in_transit_to_branch',
      `الطلب ${order.orderNumber} في الطريق إلى ${populatedOrder.branch?.name || 'غير معروف'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'in_transit') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${id} not in transit status`);
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة الشحن' });
    }

    order.status = 'delivered';
    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const deliveryConfirmedEvent = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'deliveryConfirmed', deliveryConfirmedEvent);

    const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean();
    await notifyUsers(io, users, 'branch_confirmed_receipt',
      `تم تأكيد استلام الطلب ${order.orderNumber} من ${populatedOrder.branch?.name || 'غير معروف'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming delivery:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    if (!['pending', 'approved', 'in_production', 'in_transit', 'delivered', 'completed'].includes(status)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status === status) {
      await session.abortTransaction();
      console.warn(`[${new Date().toISOString()}] Order ${id} already in status: ${status}`);
      return res.status(400).json({ success: false, message: `الطلب بالفعل في حالة ${status}` });
    }

    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const orderStatusUpdatedEvent = {
      orderId: id,
      status,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, [`branch-${order.branch}`, 'admin', 'production'], 'orderStatusUpdated', orderStatusUpdatedEvent);

    const users = await User.find({ role: { $in: ['chef', 'branch', 'admin'] }, branch: order.branch }).select('_id').lean();
    await notifyUsers(io, users, 'order_status_updated',
      `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmOrderReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid orderId: ${id}`);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found: ${id}`);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (order.status !== 'delivered') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${id} not in delivered status`);
      return res.status(400).json({ success: false, message: 'الطلب ليس في حالة التسليم' });
    }

    order.status = 'completed';
    order.statusHistory.push({
      status: 'completed',
      changedBy: req.user.id,
      changedAt: new Date(),
    });

    await order.save({ session });

    await session.commitTransaction();

    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.product', 'name')
      .lean();

    const receiptConfirmedEvent = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: populatedOrder.branch?.name || 'Unknown',
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'receiptConfirmed', receiptConfirmedEvent);

    const users = await User.find({ role: { $in: ['admin', 'production'] } }).select('_id').lean();
    await notifyUsers(io, users, 'branch_confirmed_receipt',
      `تم تأكيد استلام الطلب ${order.orderNumber} من ${populatedOrder.branch?.name || 'غير معروف'}`,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch }
    );

    res.status(200).json(populatedOrder);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming receipt:`, err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
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

module.exports = {
  checkOrderExists,
  createOrder,
  getOrders,
  getOrderById,
  createReturn,
  approveReturn,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
  confirmOrderReceipt,
};