const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const crypto = require('crypto');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Update stock for an inventory entry
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث المخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, userId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id) || !isValidObjectId(userId)) {
      console.log('تحديث المخزون - معرفات غير صالحة:', { id, userId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المخزون أو المستخدم غير صالح' : 'Invalid inventory or user ID' });
    }

    if (currentStock !== undefined && currentStock < 0) {
      console.log('تحديث المخزون - كمية غير صالحة:', { currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'كمية المخزون لا يمكن أن تكون سالبة' : 'Stock quantity cannot be negative' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث المخزون - المخزون غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المخزون غير موجود' : 'Inventory not found' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Unauthorized to update this branch inventory' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('تحديث المخزون - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found', error: 'errors.no_user' });
    }

    const oldStock = inventory.currentStock;
    if (currentStock !== undefined) inventory.currentStock = currentStock;
    if (minStockLevel !== undefined) {
      inventory.minStockLevel = minStockLevel;
      inventory.lastUpdatedBy = userId;
    }
    if (maxStockLevel !== undefined) {
      inventory.maxStockLevel = maxStockLevel;
      inventory.lastUpdatedBy = userId;
    }
    await inventory.save({ session });

    if (currentStock !== undefined && currentStock !== oldStock) {
      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        type: currentStock > oldStock ? 'restock' : 'adjustment',
        quantity: Math.abs(currentStock - oldStock),
        reference: `تحديث المخزون بواسطة ${user.name}`,
        createdBy: userId,
      });
      await historyEntry.save({ session });

      req.io?.emit('inventoryUpdated', {
        branchId: inventory.branch.toString(),
        productId: inventory.product.toString(),
        quantity: currentStock,
        type: currentStock > oldStock ? 'restock' : 'adjustment',
        reference: `تحديث المخزون`,
        eventId: crypto.randomUUID(),
      });
    }

    const populatedInventory = await Inventory.findById(id)
      .populate({
        path: 'product',
        select: 'name nameEn code unit unitEn department price',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'name nameEn')
      .populate('lastUpdatedBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedInventory = {
      ...populatedInventory,
      product: populatedInventory.product ? {
        _id: populatedInventory.product._id,
        name: isRtl ? populatedInventory.product.name : populatedInventory.product.nameEn,
        nameEn: populatedInventory.product.nameEn || populatedInventory.product.name,
        code: populedInventory.product.code || 'N/A',
        unit: isRtl ? populatedInventory.product.unit : populatedInventory.product.unitEn,
        unitEn: populatedInventory.product.unitEn || populatedInventory.product.unit,
        price: populatedInventory.product.price || 0,
        department: populatedInventory.product.department ? {
          _id: populatedInventory.product.department._id,
          name: isRtl ? populatedInventory.product.department.name : populatedInventory.product.department.nameEn,
          nameEn: populatedInventory.product.department.nameEn || populatedInventory.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
      createdByName: isRtl ? populatedInventory.createdBy?.name : populatedInventory.createdBy?.nameEn,
      lastUpdatedByName: isRtl ? populatedInventory.lastUpdatedBy?.name : populatedInventory.lastUpdatedBy?.nameEn,
      status: populatedInventory.currentStock <= populatedInventory.minStockLevel ? 'low' : populatedInventory.currentStock >= populatedInventory.maxStockLevel ? 'full' : 'normal',
    };

    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: id,
      oldStock,
      newStock: currentStock,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: formattedInventory });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Update stock limits for an inventory entry
const updateStockLimits = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث حدود المخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { minStockLevel, maxStockLevel, userId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id) || !isValidObjectId(userId)) {
      console.log('تحديث حدود المخزون - معرف غير صالح:', { id, userId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المخزون أو المستخدم غير صالح' : 'Invalid inventory or user ID' });
    }

    if (maxStockLevel <= minStockLevel) {
      console.log('تحديث حدود المخزون - حدود غير صالحة:', { minStockLevel, maxStockLevel });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' : 'Max stock level must be greater than min stock level' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث حدود المخزون - العنصر غير موجود:', { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'عنصر المخزون غير موجود' : 'Inventory item not found' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث حدود المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Unauthorized to update this branch inventory' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('تحديث حدود المخزون - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found', error: 'errors.no_user' });
    }

    inventory.minStockLevel = minStockLevel;
    inventory.maxStockLevel = maxStockLevel;
    inventory.lastUpdatedBy = userId;
    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      product: inventory.product,
      branch: inventory.branch,
      type: 'limits_update',
      quantity: 0,
      reference: `تحديث حدود المخزون (الأدنى: ${minStockLevel}, الأقصى: ${maxStockLevel}) بواسطة ${user.name}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      minStockLevel,
      maxStockLevel,
      type: 'limits_update',
      reference: `تحديث حدود المخزون بواسطة ${user.name}`,
      eventId: crypto.randomUUID(),
    });

    const populatedInventory = await Inventory.findById(id)
      .populate({
        path: 'product',
        select: 'name nameEn code unit unitEn department price',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'name nameEn')
      .populate('lastUpdatedBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedInventory = {
      ...populatedInventory,
      product: populatedInventory.product ? {
        _id: populatedInventory.product._id,
        name: isRtl ? populatedInventory.product.name : populatedInventory.product.nameEn,
        nameEn: populatedInventory.product.nameEn || populatedInventory.product.name,
        code: populatedInventory.product.code || 'N/A',
        unit: isRtl ? populatedInventory.product.unit : populatedInventory.product.unitEn,
        unitEn: populatedInventory.product.unitEn || populatedInventory.product.unit,
        price: populatedInventory.product.price || 0,
        department: populatedInventory.product.department ? {
          _id: populatedInventory.product.department._id,
          name: isRtl ? populatedInventory.product.department.name : populatedInventory.product.department.nameEn,
          nameEn: populatedInventory.product.department.nameEn || populatedInventory.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
      createdByName: isRtl ? populatedInventory.createdBy?.name : populatedInventory.createdBy?.nameEn,
      lastUpdatedByName: isRtl ? populatedInventory.lastUpdatedBy?.name : populatedInventory.lastUpdatedBy?.nameEn,
      status: populatedInventory.currentStock <= minStockLevel ? 'low' : populatedInventory.currentStock >= maxStockLevel ? 'full' : 'normal',
    };

    console.log('تحديث حدود المخزون - تم بنجاح:', {
      inventoryId: id,
      minStockLevel,
      maxStockLevel,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: formattedInventory });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث حدود المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Create a return request
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء مرتجع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, items, reason, notes, orderId, userId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || items.length === 0 || !reason) {
      console.log('إنشاء مرتجع - بيانات غير صالحة:', { branchId, userId, itemsCount: items?.length, reason });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، المستخدم، العناصر، أو السبب غير صالح' : 'Invalid branch ID, user ID, items, or reason' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || !isValidObjectId(item.itemId) || item.quantity < 1 || !item.reason)) {
      console.log('إنشاء مرتجع - عناصر غير صالحة:', { items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات، معرفات العناصر، الكميات، أو الأسباب غير صالحة' : 'Invalid product IDs, item IDs, quantities, or reasons' });
    }

    if (orderId && !isValidObjectId(orderId)) {
      console.log('إنشاء مرتجع - معرف الطلب غير صالح:', { orderId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مرتجع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مرتجع لهذا الفرع' : 'Unauthorized to create return for this branch' });
    }

    const [branch, user] = await Promise.all([
      Branch.findById(branchId).session(session),
      User.findById(userId).session(session),
    ]);

    if (!branch) {
      console.log('إنشاء مرتجع - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }
    if (!user) {
      console.log('إنشاء مرتجع - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found', error: 'errors.no_user' });
    }

    const productIds = items.map(item => item.productId);
    const itemIds = items.map(item => item.itemId);
    const [products, inventories] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).session(session).lean(),
      Inventory.find({ _id: { $in: itemIds }, branch: branchId }).session(session),
    ]);

    if (products.length !== productIds.length) {
      console.log('إنشاء مرتجع - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }
    if (inventories.length !== itemIds.length) {
      console.log('إنشاء مرتجع - بعض عناصر المخزون غير موجودة:', { itemIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض عناصر المخزون غير موجودة' : 'Some inventory items not found' });
    }

    for (const item of items) {
      const inventory = inventories.find(inv => inv._id.toString() === item.itemId && inv.product.toString() === item.productId);
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء مرتجع - الكمية غير كافية:', { productId: item.productId, itemId: item.itemId, currentStock: inventory?.currentStock, requested: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}` });
      }

      inventory.currentStock -= item.quantity;
      inventory.movements.push({
        type: 'out',
        quantity: item.quantity,
        reference: `مرتجع: ${reason}`,
        createdBy: userId,
        createdAt: new Date(),
      });
      await inventory.save({ session });

      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: branchId,
        type: 'return',
        quantity: item.quantity,
        reference: `مرتجع: ${reason} بواسطة ${user.name}`,
        createdBy: userId,
      });
      await historyEntry.save({ session });

      req.io?.emit('inventoryUpdated', {
        branchId,
        productId: item.productId,
        quantity: inventory.currentStock,
        type: 'return',
        reference: `مرتجع: ${reason}`,
        eventId: crypto.randomUUID(),
      });
    }

    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(returnCount + 1).padStart(3, '0')}`;

    const newReturn = new Return({
      returnNumber,
      branch: branchId,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason,
        inventory: item.itemId,
      })),
      reason,
      notes: notes?.trim(),
      status: 'pending_approval',
      createdBy: userId,
    });
    await newReturn.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn code unit unitEn department price',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('createdBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedItems = populatedReturn.items.map(item => ({
      ...item,
      productName: isRtl ? item.product.name : item.product.nameEn,
      unit: isRtl ? item.product.unit : item.product.unitEn,
      price: item.product.price || 0,
      departmentName: item.product.department ? (isRtl ? item.product.department.name : item.product.department.nameEn) : null,
    }));

    req.io?.to(`branch-${branchId}`).emit('returnCreated', {
      returnId: newReturn._id,
      branchId,
      status: 'pending_approval',
      items: formattedItems,
      eventId: crypto.randomUUID(),
    });

    console.log('إنشاء مرتجع - تم بنجاح:', {
      returnId: newReturn._id,
      branchId,
      userId: req.user.id,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      returnRequest: {
        ...populatedReturn,
        items: formattedItems,
        branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn,
        createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء المرتجع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all return requests
const getReturns = async (req, res) => {
  try {
    const { branchId, status, page = 1, limit = 10, lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    const query = {};
    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المرتجعات - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      query.branch = req.user.branchId;
    }
    if (status) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [returns, totalItems] = await Promise.all([
      Return.find(query)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn code unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn _id' },
        })
        .populate('createdBy', 'name nameEn')
        .populate('reviewedBy', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Return.countDocuments(query),
    ]);

    const formattedReturns = returns.map(ret => ({
      ...ret,
      branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn,
      items: ret.items.map(item => ({
        ...item,
        productName: isRtl ? item.product.name : item.product.nameEn,
        unit: isRtl ? item.product.unit : item.product.unitEn,
        price: item.product.price || 0,
        departmentName: item.product.department ? (isRtl ? item.product.department.name : item.product.department.nameEn) : null,
      })),
      createdByName: isRtl ? ret.createdBy?.name : ret.createdBy?.nameEn,
      reviewedByName: isRtl ? ret.reviewedBy?.name : ret.reviewedBy?.nameEn,
    }));

    console.log('جلب المرتجعات - تم بنجاح:', {
      count: returns.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({
      success: true,
      returns: formattedReturns,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب المرتجعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Approve or reject a return request
const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('الموافقة على المرتجع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id: returnId } = req.params;
    const { status, items, reviewNotes, userId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(returnId) || !isValidObjectId(userId) || !['approved', 'rejected'].includes(status) || !Array.isArray(items) || items.length === 0) {
      console.log('الموافقة على المرتجع - بيانات غير صالحة:', { returnId, status, userId, itemsCount: items?.length });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المرتجع، المستخدم، الحالة، أو العناصر غير صالحة' : 'Invalid return ID, user ID, status, or items' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || !isValidObjectId(item.inventoryId) || item.quantity < 1 || !['approved', 'rejected'].includes(item.status))) {
      console.log('الموافقة على المرتجع - عناصر غير صالحة:', { items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات، معرفات المخزون، الكميات، أو الحالات غير صالحة' : 'Invalid product IDs, inventory IDs, quantities, or statuses' });
    }

    const returnRequest = await Return.findById(returnId).session(session);
    if (!returnRequest) {
      console.log('الموافقة على المرتجع - المرتجع غير موجود:', { returnId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المرتجع غير موجود' : 'Return not found' });
    }

    if (req.user.role === 'branch' && returnRequest.branch.toString() !== req.user.branchId?.toString()) {
      console.log('الموافقة على المرتجع - غير مخول:', { userId: req.user.id, branchId: returnRequest.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لمعالجة مرتجع هذا الفرع' : 'Unauthorized to process return for this branch' });
    }

    if (returnRequest.status !== 'pending_approval') {
      console.log('الموافقة على المرتجع - الحالة غير صالحة:', { returnId, currentStatus: returnRequest.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'المرتجع ليس في حالة انتظار الموافقة' : 'Return is not in pending approval status' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('الموافقة على المرتجع - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found', error: 'errors.no_user' });
    }

    const productIds = items.map(item => item.productId);
    const inventoryIds = items.map(item => item.inventoryId);
    const [products, inventories] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).session(session).lean(),
      Inventory.find({ _id: { $in: inventoryIds }, branch: returnRequest.branch }).session(session),
    ]);

    if (products.length !== productIds.length) {
      console.log('الموافقة على المرتجع - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }
    if (inventories.length !== inventoryIds.length) {
      console.log('الموافقة على المرتجع - بعض عناصر المخزون غير موجودة:', { inventoryIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض عناصر المخزون غير موجودة' : 'Some inventory items not found' });
    }

    // Validate that items match the original return request
    for (const item of items) {
      const originalItem = returnRequest.items.find(
        i => i.product.toString() === item.productId && i.inventory.toString() === item.inventoryId
      );
      if (!originalItem || originalItem.quantity !== item.quantity) {
        console.log('الموافقة على المرتجع - عنصر غير متطابق:', { productId: item.productId, inventoryId: item.inventoryId, requestedQuantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'العناصر لا تتطابق مع طلب المرتجع الأصلي' : 'Items do not match the original return request' });
      }
    }

    returnRequest.status = status;
    returnRequest.reviewedBy = userId;
    returnRequest.reviewNotes = reviewNotes?.trim();
    returnRequest.reviewedAt = new Date();

    if (status === 'approved') {
      for (const item of items.filter(i => i.status === 'approved')) {
        const inventory = inventories.find(inv => inv._id.toString() === item.inventoryId && inv.product.toString() === item.productId);
        if (!inventory) {
          console.log('الموافقة على المرتجع - عنصر المخزون غير موجود:', { productId: item.productId, inventoryId: item.inventoryId });
          await session.abortTransaction();
          return res.status(404).json({ success: false, message: isRtl ? 'عنصر المخزون غير موجود' : 'Inventory item not found' });
        }

        // Stock was already deducted during createReturn, no further adjustment needed
        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: returnRequest.branch,
          type: 'return_approved',
          quantity: item.quantity,
          reference: `مرتجع تمت الموافقة عليه: ${returnRequest.reason} بواسطة ${user.name}`,
          createdBy: userId,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: returnRequest.branch.toString(),
          productId: item.productId,
          quantity: inventory.currentStock,
          type: 'return_approved',
          reference: `مرتجع تمت الموافقة عليه: ${returnRequest.reason}`,
          eventId: crypto.randomUUID(),
        });
      }
    } else if (status === 'rejected') {
      // Return stock to inventory for rejected items
      for (const item of items.filter(i => i.status === 'rejected')) {
        const inventory = inventories.find(inv => inv._id.toString() === item.inventoryId && inv.product.toString() === item.productId);
        if (!inventory) {
          console.log('الموافقة على المرتجع - عنصر المخزون غير موجود:', { productId: item.productId, inventoryId: item.inventoryId });
          await session.abortTransaction();
          return res.status(404).json({ success: false, message: isRtl ? 'عنصر المخزون غير موجود' : 'Inventory item not found' });
        }

        inventory.currentStock += item.quantity;
        inventory.movements.push({
          type: 'in',
          quantity: item.quantity,
          reference: `مرتجع مرفوض: ${returnRequest.reason}`,
          createdBy: userId,
          createdAt: new Date(),
        });
        await inventory.save({ session });

        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: returnRequest.branch,
          type: 'return_rejected',
          quantity: item.quantity,
          reference: `مرتجع مرفوض: ${returnRequest.reason} بواسطة ${user.name}`,
          createdBy: userId,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: returnRequest.branch.toString(),
          productId: item.productId,
          quantity: inventory.currentStock,
          type: 'return_rejected',
          reference: `مرتجع مرفوض: ${returnRequest.reason}`,
          eventId: crypto.randomUUID(),
        });
      }
    }

    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(returnId)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn code unit unitEn department price',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('createdBy', 'name nameEn')
      .populate('reviewedBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedItems = populatedReturn.items.map(item => ({
      ...item,
      productName: isRtl ? item.product.name : item.product.nameEn,
      unit: isRtl ? item.product.unit : item.product.unitEn,
      price: item.product.price || 0,
      departmentName: item.product.department ? (isRtl ? item.product.department.name : item.product.department.nameEn) : null,
    }));

    req.io?.to(`branch-${returnRequest.branch.toString()}`).emit('returnUpdated', {
      returnId,
      branchId: returnRequest.branch.toString(),
      status,
      items: formattedItems,
      eventId: crypto.randomUUID(),
    });

    console.log('الموافقة على المرتجع - تم بنجاح:', {
      returnId,
      status,
      userId: req.user.id,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      returnRequest: {
        ...populatedReturn,
        items: formattedItems,
        branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn,
        createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn,
        reviewedByName: isRtl ? populatedReturn.reviewedBy?.name : populatedReturn.reviewedBy?.nameEn,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في الموافقة على المرتجع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  updateStock,
  updateStockLimits,
  createReturn,
  getReturns,
  approveReturn,
};