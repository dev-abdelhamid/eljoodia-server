const mongoose = require('mongoose');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { updateInventoryStock } = require('../utils/inventoryUtils');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// دالة لتوليد رقم إرجاع فريد
const generateReturnNumber = async (branchId, session) => {
  const count = await Return.countDocuments({ branch: branchId }).session(session);
  return `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(count + 1).toString().padStart(4, '0')}`;
};

// تجميع العناصر حسب المنتج لتجنب التضارب في تحديث المخزون
const aggregateItemsByProduct = (items) => {
  const aggregated = {};
  items.forEach((item, index) => {
    if (!aggregated[item.product]) {
      aggregated[item.product] = {
        product: item.product,
        quantity: 0,
        price: item.price || 0,
        reason: item.reason,
        reasonEn: item.reasonEn,
      };
    }
    aggregated[item.product].quantity += item.quantity;
  });
  return Object.values(aggregated);
};

const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { branchId, items, notes = '', orders = [] } = req.body;

    // التحقق من المدخلات
    if (!isValidObjectId(branchId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    if (!Array.isArray(items) || !items.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'العناصر مطلوبة' : 'Items are required' });
    }
    if (!Array.isArray(orders) || orders.some(id => !isValidObjectId(id))) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات الطلبات غير صالحة' : 'Invalid order IDs' });
    }

    // التحقق من الفرع
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    // التحقق من صلاحيات المستخدم
    if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مصرح لك بإنشاء طلب إرجاع لهذا الفرع' : 'Not authorized to create a return for this branch',
      });
    }

    // التحقق من المنتجات
    const productIds = [...new Set(items.map(item => item.product))];
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found',
      });
    }

    // التحقق من المخزون
    const inventories = await Inventory.find({
      branch: branchId,
      product: { $in: productIds },
    }).session(session);
    
    const inventoryMap = {};
    inventories.forEach(inv => {
      inventoryMap[inv.product.toString()] = inv;
    });

    const errors = [];
    items.forEach((item, index) => {
      if (!isValidObjectId(item.product)) {
        errors.push({ path: `items[${index}].product`, msg: isRtl ? 'معرف المنتج غير صالح' : 'Invalid product ID' });
      }
      const inventory = inventoryMap[item.product];
      if (!inventory) {
        errors.push({ path: `items[${index}].product`, msg: isRtl ? 'المنتج غير موجود في المخزون' : 'Product not found in inventory' });
      } else if (item.quantity > inventory.currentStock) {
        errors.push({
          path: `items[${index}].quantity`,
          msg: isRtl ? `الكمية غير كافية للمنتج في المخزون: ${item.quantity} > ${inventory.currentStock}` : 
                `Insufficient quantity for product in inventory: ${item.quantity} > ${inventory.currentStock}`,
        });
      }
      if (!item.reason || !item.reasonEn) {
        errors.push({ path: `items[${index}].reason`, msg: isRtl ? 'سبب الإرجاع مطلوب' : 'Return reason is required' });
      }
    });

    if (errors.length > 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data', errors });
    }

    // تجميع العناصر حسب المنتج
    const aggregatedItems = aggregateItemsByProduct(items);

    // إنشاء طلب الإرجاع
    const returnNumber = await generateReturnNumber(branchId, session);
    const newReturn = new Return({
      branch: branchId,
      items: aggregatedItems,
      notes,
      orders,
      status: 'pending_approval',
      returnNumber,
      createdBy: req.user._id,
    });

    // تحديث المخزون
    for (const item of aggregatedItems) {
      try {
        await updateInventoryStock({
          branchId,
          productId: item.product,
          quantity: item.quantity,
          operation: 'increment',
          type: 'return_pending',
          description: isRtl ? `طلب إرجاع: ${returnNumber}` : `Return request: ${returnNumber}`,
          session,
        });
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error updating inventory for product ${item.product}:`, {
          branchId,
          quantity: item.quantity,
          error: error.message,
          stack: error.stack,
        });
        throw new Error(isRtl ? `تضارب في تحديث المخزون للمنتج ${item.product}` : `Conflict in updating inventory stock for product ${item.product}`);
      }
    }

    // حفظ طلب الإرجاع
    await newReturn.save({ session });

    // إنشاء إشعار
    await createNotification({
      userId: req.user._id,
      type: 'return_created',
      message: isRtl ? `تم إنشاء طلب إرجاع جديد: ${returnNumber}` : `New return request created: ${returnNumber}`,
      data: { returnId: newReturn._id, returnNumber },
      session,
    });

    await session.commitTransaction();

    // إرسال حدث عبر WebSocket
    if (req.io) {
      req.io.to(`branch:${branchId}`).emit('returnCreated', {
        branchId,
        returnId: newReturn._id,
        returnNumber,
        status: 'pending_approval',
        eventId: new mongoose.Types.ObjectId().toString(),
      });
    }

    return res.status(201).json({
      success: true,
      returnRequest: newReturn,
      message: isRtl ? 'تم إنشاء طلب الإرجاع بنجاح' : 'Return request created successfully',
    });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, {
      branchId: req.body.branchId,
      items: req.body.items,
      userId: req.user._id,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في إنشاء طلب الإرجاع' : 'Error creating return request',
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

const approveReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes = '' } = req.body;

    // التحقق من المدخلات
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة غير صالحة' : 'Invalid status' });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Not authorized to approve return' });
    }

    // التحقق من الإرجاع
    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
    }
    if (returnRequest.status !== 'pending_approval') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval' });
    }

    // تجميع العناصر حسب المنتج
    const aggregatedItems = aggregateItemsByProduct(returnRequest.items);

    // تحديث المخزون بناءً على الحالة
    let adjustedTotal = 0;
    if (status === 'approved') {
      for (const item of aggregatedItems) {
        const inventory = await Inventory.findOne({ branch: returnRequest.branch, product: item.product }).session(session);
        if (!inventory || inventory.pendingReturnStock < item.quantity) {
          await session.abortTransaction();
          return res.status(422).json({
            success: false,
            message: isRtl ? `الكمية المحجوزة غير كافية للمنتج ${item.product}` : `Insufficient reserved quantity for product ${item.product}`,
          });
        }
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: item.product,
          quantity: -item.quantity,
          type: 'return_approved',
          reference: `مرتجع موافق عليه #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn})`,
          isDamaged: item.reason === 'تالف' || item.reasonEn === 'Damaged',
        });
        adjustedTotal += item.quantity * item.price;
      }
    } else if (status === 'rejected') {
      for (const item of aggregatedItems) {
        const inventory = await Inventory.findOne({ branch: returnRequest.branch, product: item.product }).session(session);
        if (!inventory || inventory.pendingReturnStock < item.quantity) {
          await session.abortTransaction();
          return res.status(422).json({
            success: false,
            message: isRtl ? `الكمية المحجوزة غير كافية للمنتج ${item.product}` : `Insufficient reserved quantity for product ${item.product}`,
          });
        }
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: item.product,
          quantity: item.quantity,
          type: 'return_rejected',
          reference: `مرتجع مرفوض #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          isDamaged: item.reason === 'تالف' || item.reasonEn === 'Damaged',
          notes: `${item.reason} (${item.reasonEn})`,
        });
      }
    }

    // تحديث حالة الإرجاع
    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: reviewNotes.trim(),
      changedAt: new Date(),
    });
    await returnRequest.save({ session });

    await session.commitTransaction();

    // إرجاع البيانات المنسقة
    const populatedReturn = await Return.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('orders', 'orderNumber')
      .populate('createdBy', 'name nameEn username')
      .populate('reviewedBy', 'name nameEn username')
      .lean();

    const formattedReturn = {
      ...populatedReturn,
      branch: {
        ...populatedReturn.branch,
        displayName: isRtl ? (populatedReturn.branch?.name || 'غير معروف') : (populatedReturn.branch?.nameEn || populatedReturn.branch?.name || 'غير معروف'),
      },
      items: populatedReturn.items.map(item => ({
        ...item,
        product: {
          ...item.product,
          displayName: isRtl ? (item.product?.name || 'غير معروف') : (item.product?.nameEn || item.product?.name || 'غير معروف'),
          displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
          department: item.product?.department ? {
            ...item.product.department,
            displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
          } : null,
        },
        reasonDisplay: isRtl ? item.reason : item.reasonEn,
      })),
      createdByDisplay: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'غير معروف'),
      reviewedByDisplay: isRtl ? (populatedReturn.reviewedBy?.name || 'غير معروف') : (populatedReturn.reviewedBy?.nameEn || populatedReturn.reviewedBy?.name || 'غير معروف'),
    };

    // إرسال إشعارات غير متزامنة
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.branch },
      ],
    }).select('_id').lean();

    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'returnStatusUpdated',
        isRtl ? `تم تحديث حالة المرتجع ${populatedReturn.returnNumber} إلى ${status === 'approved' ? 'موافق عليه' : 'مرفوض'}` : `Return ${populatedReturn.returnNumber} updated to ${status}`,
        { returnId: id, branchId: returnRequest.branch, status, eventId: `${id}-returnStatusUpdated` },
        io,
        true
      );
    }

    console.log(`[${new Date().toISOString()}] تحديث حالة المرتجع - تم بنجاح:`, {
      returnId: id,
      returnNumber: returnRequest.returnNumber,
      status,
      userId: req.user.id,
    });

    res.status(200).json({ success: true, returnRequest: { ...formattedReturn, adjustedTotal } });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تحديث المرتجع:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) status = 422;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid') || err.message.includes('pending')) status = 400;
    else if (err.name === 'ValidationError') {
      status = 400;
      message = isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error';
    } else if (err.message.includes('conflict at \'currentStock\'')) {
      status = 409;
      message = isRtl ? 'تضارب في تحديث المخزون، يرجى المحاولة لاحقًا' : 'Conflict in updating inventory stock, please try again later';
    }
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };