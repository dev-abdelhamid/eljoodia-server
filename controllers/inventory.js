const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب مخزون الفرع (مع pagination)
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock, page = 1, limit = 10 } = req.query;
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المخزون - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    const skip = (page - 1) * limit;
    const inventoryItems = await Inventory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .skip(skip)
      .limit(limit)
      .lean();

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    const totalItems = await Inventory.countDocuments(query);
    const totalPages = Math.ceil(totalItems / limit);

    console.log('جلب المخزون - تم بنجاح:', {
      count: filteredItems.length,
      userId: req.user.id,
      query,
      page,
      limit,
    });

    res.status(200).json({ success: true, inventory: filteredItems, totalPages, currentPage: Number(page) });
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }

    const skip = (page - 1) * limit;
    const inventoryItems = await Inventory.find({ branch: branchId })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .skip(skip)
      .limit(limit)
      .lean();

    const totalItems = await Inventory.countDocuments({ branch: branchId });
    const totalPages = Math.ceil(totalItems / limit);

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
      page,
      limit,
    });

    res.status(200).json({ success: true, inventory: inventoryItems, totalPages, currentPage: Number(page) });
  } catch (err) {
    console.error('خطأ في جلب المخزون حسب الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};
// تحديث حدود المخزون (min/max فقط)
const updateStockLimits = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { minStockLevel, maxStockLevel } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    if (maxStockLevel <= minStockLevel) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
    }

    // تحقق الفرع
    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    inventory.minStockLevel = minStockLevel;
    inventory.maxStockLevel = maxStockLevel;
    await inventory.save({ session });

    // إشعار socket
    req.app.get('io')?.to(`branch-${inventory.branch}`).emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      minStockLevel,
      maxStockLevel
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error in updateStockLimits:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  } finally {
    session.endSession();
  }
};

// إنشاء مرتجع مباشرة من المخزون (orderId optional)
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, items, reason, notes } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !Array.isArray(items) || items.length === 0 || !reason) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، العناصر، أو السبب مطلوب' });
    }

    // تحقق الفرع
    if (req.user.role === 'branch' && branchId !== req.user.branchId) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // تحقق العناصر والمخزون
    for (const item of items) {
      if (!isValidObjectId(item.productId) || item.quantity < 1 || !item.reason) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }

      const inventory = await Inventory.findOne({ product: item.productId, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.productId}` });
      }

      // خصم فوري من المخزون
      await Inventory.findByIdAndUpdate(inventory._id, {
        $inc: { currentStock: -item.quantity }
      }, { session });
    }

    // إنشاء رقم المرتجع
    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(returnCount + 1).padStart(3, '0')}`;

    // إنشاء المرتجع
    const newReturn = new Return({
      returnNumber,
      branch: branchId,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason
      })),
      reason,
      notes: notes?.trim(),
      status: 'pending_approval',
      createdBy: req.user.id
    });
    await newReturn.save({ session });

    // Populate الـ response
    const populatedReturn = await Return.findById(newReturn._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'name nameEn')
      .session(session)
      .lean();

    // Formatting حسب اللغة
    const formattedItems = populatedReturn.items.map(item => ({
      ...item,
      productName: isRtl ? item.product.name : item.product.nameEn,
      unit: isRtl ? item.product.unit : item.product.unitEn,
      departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn
    }));

    // Notifications & Socket
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [{ role: { $in: ['admin', 'production'] } }, { role: 'branch', branch: branchId }]
    }).select('_id').lean();

    await Promise.all(usersToNotify.map(user => 
      createNotification(user._id, 'info', 'notifications.return_pending', { returnId: newReturn._id }, io)
    ));

    io?.to(['admin', 'production', `branch-${branchId}`]).emit('returnCreated', {
      returnId: newReturn._id,
      branchId,
      status: 'pending_approval',
      items: formattedItems
    });

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      returnRequest: {
        ...populatedReturn,
        items: formattedItems,
        createdByName: isRtl ? populatedReturn.createdBy.name : populatedReturn.createdBy.nameEn
      }
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error in createReturn:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  } finally {
    session.endSession();
  }
};

// جلب المرتجعات (مع pagination وfilter)
const getReturns = async (req, res) => {
  try {
    const { branchId, status, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const query = {};
    if (branchId && isValidObjectId(branchId)) query.branch = branchId;
    if (req.user.role === 'branch' && !branchId) query.branch = req.user.branchId;
    if (status) query.status = status;

    // تحقق الصلاحيات
    if (req.user.role === 'branch' && branchId && branchId !== req.user.branchId) {
      return res.status(403).json({ success: false, message: 'غير مخول لهذا الفرع' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [returns, totalItems] = await Promise.all([
      Return.find(query)
        .populate('branch', 'name nameEn')
        .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
        .populate('createdBy', 'name nameEn')
        .populate('reviewedBy', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Return.countDocuments(query)
    ]);

    const totalPages = Math.ceil(totalItems / parseInt(limit));

    // Formatting
    const formattedReturns = returns.map(ret => ({
      ...ret,
      branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn,
      items: ret.items.map(item => ({
        ...item,
        productName: isRtl ? item.product.name : item.product.nameEn,
        unit: isRtl ? item.product.unit : item.product.unitEn,
        departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn
      })),
      createdByName: isRtl ? ret.createdBy?.name : ret.createdBy?.nameEn,
      reviewedByName: ret.reviewedBy ? (isRtl ? ret.reviewedBy.name : ret.reviewedBy.nameEn) : null
    }));

    res.status(200).json({
      success: true,
      returns: formattedReturns,
      totalPages,
      currentPage: parseInt(page)
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error in getReturns:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

// الموافقة/رفض المرتجع
const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المرتجع غير صالح' });
    }

    if (!['approved', 'rejected'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'حالة غير صالحة (approved أو rejected)' });
    }

    // صلاحيات (admin/production فقط)
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول للموافقة' });
    }

    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المرتجع غير موجود' });
    }

    if (returnRequest.status !== 'pending_approval') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'المرتجع غير في انتظار الموافقة' });
    }

    // تحديث الحالة
    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    await returnRequest.save({ session });

    // إذا rejected، أعد الكمية إلى المخزون
    if (status === 'rejected') {
      for (const item of returnRequest.items) {
        await Inventory.findOneAndUpdate(
          { product: item.product, branch: returnRequest.branch },
          { $inc: { currentStock: item.quantity } },
          { session }
        );
      }
    }
    // إذا approved، لا تفعل شيئًا (الخصم تم مسبقًا)

    // Populate response
    const populatedReturn = await Return.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'name nameEn')
      .populate('reviewedBy', 'name nameEn')
      .session(session)
      .lean();

    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';
    const formattedItems = populatedReturn.items.map(item => ({
      ...item,
      productName: isRtl ? item.product.name : item.product.nameEn,
      unit: isRtl ? item.product.unit : item.product.unitEn,
      departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn
    }));

    // Notifications & Socket
    const io = req.app.get('io');
    io?.to(['admin', 'production', `branch-${returnRequest.branch}`]).emit('returnStatusUpdated', {
      returnId: id,
      status,
      branchId: returnRequest.branch
    });

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      returnRequest: {
        ...populatedReturn,
        items: formattedItems,
        createdByName: isRtl ? populatedReturn.createdBy.name : populatedReturn.createdBy.nameEn,
        reviewedByName: isRtl ? populatedReturn.reviewedBy.name : populatedReturn.reviewedBy.nameEn
      }
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error in approveReturn:`, err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  } finally {
    session.endSession();
  }
};

module.exports = {
  getInventory, 
  getInventoryByBranch,
  updateStockLimits,
  createReturn,
  getReturns,
  approveReturn
};