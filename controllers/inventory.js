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

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock, page = 1, limit = 10, lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    const query = {};
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    }
    if (product && isValidObjectId(product)) {
      query.product = product;
    }
    if (lowStock === 'true') {
      query.$expr = { $lte: ['$currentStock', '$minStockLevel'] };
    }
    if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المخزون - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      query.branch = req.user.branchId;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [inventoryItems, totalItems] = await Promise.all([
      Inventory.find(query)
        .populate({
          path: 'product',
          select: 'name nameEn code unit unitEn department',
          populate: { path: 'department', select: 'name nameEn _id' },
        })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments(query),
    ]);

    const formattedInventory = inventoryItems.map(item => ({
      ...item,
      product: item.product ? {
        _id: item.product._id,
        name: isRtl ? item.product.name : item.product.nameEn,
        nameEn: item.product.nameEn || item.product.name,
        code: item.product.code || 'N/A',
        unit: isRtl ? item.product.unit : item.product.unitEn,
        unitEn: item.product.unitEn || item.product.unit,
        department: item.product.department ? {
          _id: item.product.department._id,
          name: isRtl ? item.product.department.name : item.product.department.nameEn,
          nameEn: item.product.department.nameEn || item.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      status: item.currentStock <= item.minStockLevel ? 'low' : item.currentStock >= item.maxStockLevel ? 'full' : 'normal',
    }));

    console.log('جلب المخزون - تم بنجاح:', {
      count: inventoryItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({
      success: true,
      inventory: formattedInventory,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { page = 1, limit = 10, search, lowStock, lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى مخزون هذا الفرع' : 'Unauthorized to access this branch inventory' });
    }

    const query = { branch: branchId };
    if (search) {
      const products = await Product.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { nameEn: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
        ],
      }).select('_id');
      query.product = { $in: products.map(p => p._id) };
    }
    if (lowStock === 'true') {
      query.$expr = { $lte: ['$currentStock', '$minStockLevel'] };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [inventoryItems, totalItems] = await Promise.all([
      Inventory.find(query)
        .populate({
          path: 'product',
          select: 'name nameEn code unit unitEn department',
          populate: { path: 'department', select: 'name nameEn _id' },
        })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments(query),
    ]);

    const formattedItems = inventoryItems.map(item => ({
      ...item,
      product: item.product ? {
        _id: item.product._id,
        name: isRtl ? item.product.name : item.product.nameEn,
        nameEn: item.product.nameEn || item.product.name,
        code: item.product.code || 'N/A',
        unit: isRtl ? item.product.unit : item.product.unitEn,
        unitEn: item.product.unitEn || item.product.unit,
        department: item.product.department ? {
          _id: item.product.department._id,
          name: isRtl ? item.product.department.name : item.product.department.nameEn,
          nameEn: item.product.department.nameEn || item.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      status: item.currentStock <= item.minStockLevel ? 'low' : item.currentStock >= item.maxStockLevel ? 'full' : 'normal',
    }));

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', {
      count: formattedItems.length,
      branchId,
      userId: req.user.id,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      inventory: formattedItems,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب المخزون حسب الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Create a new inventory entry
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء مخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, currentStock, minStockLevel = 0, maxStockLevel = 1000, userId, orderId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || (orderId && !isValidObjectId(orderId))) {
      console.log('إنشاء مخزون - معرفات غير صالحة:', { branchId, productId, userId, orderId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، المنتج، أو المستخدم غير صالح' : 'Invalid branch, product, or user ID' });
    }

    if (currentStock < 0) {
      console.log('إنشاء مخزون - كمية غير صالحة:', { currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'كمية المخزون لا يمكن أن تكون سالبة' : 'Stock quantity cannot be negative' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Unauthorized to create inventory for this branch' });
    }

    const [product, branch, user] = await Promise.all([
      Product.findById(productId).session(session).lean(),
      Branch.findById(branchId).session(session).lean(),
      User.findById(userId).session(session).lean(),
    ]);

    if (!product) {
      console.log('إنشاء مخزون - المنتج غير موجود:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }
    if (!branch) {
      console.log('إنشاء مخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }
    if (!user) {
      console.log('إنشاء مخزون - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }

    const existingInventory = await Inventory.findOne({ product: productId, branch: branchId }).session(session);
    if (existingInventory) {
      console.log('إنشاء مخزون - المخزون موجود مسبقًا:', { productId, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'المخزون موجود مسبقًا لهذا المنتج والفرع' : 'Inventory already exists for this product and branch' });
    }

    const inventory = new Inventory({
      product: productId,
      branch: branchId,
      currentStock,
      minStockLevel,
      maxStockLevel,
    });
    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      type: 'restock',
      quantity: currentStock,
      reference: orderId ? `إنشاء مخزون جديد لطلب ${orderId} بواسطة ${user.name}` : `إنشاء مخزون جديد بواسطة ${user.name}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: currentStock,
      type: 'restock',
      reference: orderId ? `إنشاء مخزون جديد لطلب ${orderId}` : `إنشاء مخزون جديد`,
      eventId: crypto.randomUUID(),
    });

    const populatedInventory = await Inventory.findById(inventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('branch', 'name nameEn')
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
        department: populatedInventory.product.department ? {
          _id: populatedInventory.product.department._id,
          name: isRtl ? populatedInventory.product.department.name : populatedInventory.product.department.nameEn,
          nameEn: populatedInventory.product.department.nameEn || populatedInventory.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
      status: populatedInventory.currentStock <= populatedInventory.minStockLevel ? 'low' : populatedInventory.currentStock >= populatedInventory.maxStockLevel ? 'full' : 'normal',
    };

    console.log('إنشاء مخزون - تم بنجاح:', { inventoryId: inventory._id, userId: req.user.id });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: formattedInventory });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

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
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }

    const oldStock = inventory.currentStock;
    if (currentStock !== undefined) inventory.currentStock = currentStock;
    if (minStockLevel !== undefined) inventory.minStockLevel = minStockLevel;
    if (maxStockLevel !== undefined) inventory.maxStockLevel = maxStockLevel;
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
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('branch', 'name nameEn')
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
        department: populatedInventory.product.department ? {
          _id: poppedInventory.product.department._id,
          name: isRtl ? populatedInventory.product.department.name : populatedInventory.product.department.nameEn,
          nameEn: populatedInventory.product.department.nameEn || populatedInventory.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
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
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }

    inventory.minStockLevel = minStockLevel;
    inventory.maxStockLevel = maxStockLevel;
    await inventory.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      minStockLevel,
      maxStockLevel,
      type: 'limits_update',
      eventId: crypto.randomUUID(),
    });

    const populatedInventory = await Inventory.findById(id)
      .populate({
        path: 'product',
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('branch', 'name nameEn')
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
        department: populatedInventory.product.department ? {
          _id: populatedInventory.product.department._id,
          name: isRtl ? populatedInventory.product.department.name : populatedInventory.product.department.nameEn,
          nameEn: populatedInventory.product.department.nameEn || populatedInventory.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
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

// Bulk create inventory entries
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء مخزون بالجملة - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, items, userId, orderId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || items.length === 0) {
      console.log('إنشاء مخزون بالجملة - بيانات غير صالحة:', { branchId, userId, itemsCount: items?.length });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، المستخدم، أو العناصر غير صالحة' : 'Invalid branch ID, user ID, or items' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.currentStock < 0)) {
      console.log('إنشاء مخزون بالجملة - عناصر غير صالحة:', { items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات أو الكميات غير صالحة' : 'Invalid product IDs or quantities' });
    }

    if (orderId && !isValidObjectId(orderId)) {
      console.log('إنشاء مخزون بالجملة - معرف الطلب غير صالح:', { orderId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مخزون بالجملة - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Unauthorized to create inventory for this branch' });
    }

    const [branch, user] = await Promise.all([
      Branch.findById(branchId).session(session).lean(),
      User.findById(userId).session(session).lean(),
    ]);

    if (!branch) {
      console.log('إنشاء مخزون بالجملة - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }
    if (!user) {
      console.log('إنشاء مخزون بالجملة - المستخدم غير موجود:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('إنشاء مخزون بالجملة - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    const existingInventories = await Inventory.find({ branch: branchId, product: { $in: productIds } }).session(session);
    if (existingInventories.length > 0) {
      console.log('إنشاء مخزون بالجملة - مخزون موجود مسبقًا:', { existing: existingInventories.map(inv => inv.product.toString()) });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'مخزون موجود مسبقًا لبعض المنتجات في هذا الفرع' : 'Inventory already exists for some products in this branch' });
    }

    const inventories = items.map(item => ({
      product: item.productId,
      branch: branchId,
      currentStock: item.currentStock,
      minStockLevel: item.minStockLevel ?? 0,
      maxStockLevel: item.maxStockLevel ?? 1000,
    }));

    const savedInventories = await Inventory.insertMany(inventories, { session });

    const historyEntries = items.map((item, index) => ({
      product: item.productId,
      branch: branchId,
      type: 'restock',
      quantity: item.currentStock,
      reference: orderId ? `إنشاء مخزون بالجملة لطلب ${orderId} بواسطة ${user.name}` : `إنشاء مخزون بالجملة بواسطة ${user.name}`,
      createdBy: userId,
    }));
    await InventoryHistory.insertMany(historyEntries, { session });

    for (const item of items) {
      req.io?.emit('inventoryUpdated', {
        branchId,
        productId: item.productId,
        quantity: item.currentStock,
        type: 'restock',
        reference: orderId ? `إنشاء مخزون بالجملة لطلب ${orderId}` : `إنشاء مخزون بالجملة`,
        eventId: crypto.randomUUID(),
      });
    }

    const populatedInventories = await Inventory.find({ _id: { $in: savedInventories.map(inv => inv._id) } })
      .populate({
        path: 'product',
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    const formattedInventories = populatedInventories.map(item => ({
      ...item,
      product: item.product ? {
        _id: item.product._id,
        name: isRtl ? item.product.name : item.product.nameEn,
        nameEn: item.product.nameEn || item.product.name,
        code: item.product.code || 'N/A',
        unit: isRtl ? item.product.unit : item.product.unitEn,
        unitEn: item.product.unitEn || item.product.unit,
        department: item.product.department ? {
          _id: item.product.department._id,
          name: isRtl ? item.product.department.name : item.product.department.nameEn,
          nameEn: item.product.department.nameEn || item.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      status: item.currentStock <= item.minStockLevel ? 'low' : item.currentStock >= item.maxStockLevel ? 'full' : 'normal',
    }));

    console.log('إنشاء مخزون بالجملة - تم بنجاح:', {
      branchId,
      count: savedInventories.length,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: formattedInventories });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء مخزون بالجملة:', { error: err.message, stack: err.stack, requestBody: req.body });
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

    const { branchId, items, reason, notes, lang = 'ar' } = req.body;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !Array.isArray(items) || items.length === 0 || !reason) {
      console.log('إنشاء مرتجع - بيانات غير صالحة:', { branchId, itemsCount: items?.length, reason });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، العناصر، أو السبب غير صالح' : 'Invalid branch ID, items, or reason' });
    }

    if (items.some(item => !isValidObjectId(item.product) || item.quantity < 1 || !item.reason)) {
      console.log('إنشاء مرتجع - عناصر غير صالحة:', { items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات، الكميات، أو الأسباب غير صالحة' : 'Invalid product IDs, quantities, or reasons' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مرتجع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مرتجع لهذا الفرع' : 'Unauthorized to create return for this branch' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('إنشاء مرتجع - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    const productIds = items.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('إنشاء مرتجع - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    for (const item of items) {
      const inventory = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء مرتجع - الكمية غير كافية:', { productId: item.product, currentStock: inventory?.currentStock, requested: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient stock for product ${item.product}` });
      }

      inventory.currentStock -= item.quantity;
      inventory.movements.push({
        type: 'out',
        quantity: item.quantity,
        reference: `مرتجع: ${reason}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
      await inventory.save({ session });

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch: branchId,
        type: 'return',
        quantity: item.quantity,
        reference: `مرتجع: ${reason}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      req.io?.emit('inventoryUpdated', {
        branchId,
        productId: item.product,
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
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      reason,
      notes: notes?.trim(),
      status: 'pending_approval',
      createdBy: req.user.id,
    });
    await newReturn.save({ session });

    const populatedReturn = await Return.findById(newReturn._id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('createdBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedItems = populatedReturn.items.map(item => ({
      ...item,
      productName: isRtl ? item.product.name : item.product.nameEn,
      unit: isRtl ? item.product.unit : item.product.unitEn,
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
          select: 'name nameEn code unit unitEn department',
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
    const { status, items, reviewNotes } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(returnId) || !['approved', 'rejected'].includes(status) || !Array.isArray(items) || items.length === 0) {
      console.log('الموافقة على المرتجع - بيانات غير صالحة:', { returnId, status, itemsCount: items?.length });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المرتجع، الحالة، أو العناصر غير صالحة' : 'Invalid return ID, status, or items' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.quantity < 1 || !['approved', 'rejected'].includes(item.status))) {
      console.log('الموافقة على المرتجع - عناصر غير صالحة:', { items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات، الكميات، أو الحالات غير صالحة' : 'Invalid product IDs, quantities, or statuses' });
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
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن معالجة مرتجع ليس بحالة قيد الانتظار' : 'Cannot process return that is not pending' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('الموافقة على المرتجع - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    returnRequest.status = status;
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewNotes = reviewNotes;
    returnRequest.reviewedAt = new Date();

    for (const item of items) {
      const returnItem = returnRequest.items.find(i => i.product.toString() === item.productId);
      if (!returnItem || returnItem.quantity !== item.quantity) {
        console.log('الموافقة على المرتجع - عنصر غير متطابق:', { productId: item.productId, requestedQuantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'عنصر المرتجع غير متطابق' : 'Return item mismatch' });
      }
      returnItem.status = item.status;
      returnItem.reviewNotes = item.reviewNotes;

      if (item.status === 'approved') {
        const inventory = await Inventory.findOne({ product: item.productId, branch: returnRequest.branch }).session(session);
        if (!inventory) {
          console.log('الموافقة على المرتجع - المخزون غير موجود:', { productId: item.productId, branchId: returnRequest.branch });
          await session.abortTransaction();
          return res.status(404).json({ success: false, message: isRtl ? 'المخزون غير موجود لهذا المنتج' : 'Inventory not found for this product' });
        }
        inventory.currentStock += item.quantity;
        inventory.movements.push({
          type: 'in',
          quantity: item.quantity,
          reference: `موافقة مرتجع ${returnRequest.returnNumber}`,
          createdBy: req.user.id,
          createdAt: new Date(),
        });
        await inventory.save({ session });

        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: returnRequest.branch,
          type: 'return',
          quantity: item.quantity,
          reference: `موافقة مرتجع ${returnRequest.returnNumber} بواسطة ${req.user.name}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: returnRequest.branch.toString(),
          productId: item.productId,
          quantity: inventory.currentStock,
          type: 'return',
          reference: `موافقة مرتجع ${returnRequest.returnNumber}`,
          eventId: crypto.randomUUID(),
        });
      }
    }

    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn code unit unitEn department',
        populate: { path: 'department', select: 'name nameEn _id' },
      })
      .populate('createdBy', 'name nameEn')
      .populate('reviewedBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedReturn = {
      ...populatedReturn,
      branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn,
      items: populatedReturn.items.map(item => ({
        ...item,
        productName: isRtl ? item.product.name : item.product.nameEn,
        unit: isRtl ? item.product.unit : item.product.unitEn,
        departmentName: item.product.department ? (isRtl ? item.product.department.name : item.product.department.nameEn) : null,
      })),
      createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn,
      reviewedByName: isRtl ? populatedReturn.reviewedBy?.name : populatedReturn.reviewedBy?.nameEn,
    };

    req.io?.to(`branch-${returnRequest.branch.toString()}`).emit('returnUpdated', {
      returnId: returnRequest._id,
      branchId: returnRequest.branch.toString(),
      status,
      items: formattedReturn.items,
      eventId: crypto.randomUUID(),
    });

    console.log('الموافقة على المرتجع - تم بنجاح:', {
      returnId: returnRequest._id,
      status,
      userId: req.user.id,
    });

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      returnRequest: formattedReturn,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في معالجة المرتجع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const { branchId, productId, page = 1, limit = 10, lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    const query = {};
    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب سجل المخزون - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      query.branch = req.user.branchId;
    }
    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }

    if (req.user.role === 'branch' && branchId && branchId !== req.user.branchId?.toString()) {
      console.log('جلب سجل المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى سجل مخزون هذا الفرع' : 'Unauthorized to access this branch inventory history' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [historyItems, totalItems] = await Promise.all([
      InventoryHistory.find(query)
        .populate({
          path: 'product',
          select: 'name nameEn code unit unitEn department',
          populate: { path: 'department', select: 'name nameEn _id' },
        })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn')
        .populate('transferDetails.fromBranch', 'name nameEn')
        .populate('transferDetails.toBranch', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      InventoryHistory.countDocuments(query),
    ]);

    const formattedHistory = historyItems.map(item => ({
      ...item,
      product: item.product ? {
        _id: item.product._id,
        name: isRtl ? item.product.name : item.product.nameEn,
        nameEn: item.product.nameEn || item.product.name,
        code: item.product.code || 'N/A',
        unit: isRtl ? item.product.unit : item.product.unitEn,
        unitEn: item.product.unitEn || item.product.unit,
        department: item.product.department ? {
          _id: item.product.department._id,
          name: isRtl ? item.product.department.name : item.product.department.nameEn,
          nameEn: item.product.department.nameEn || item.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      createdByName: isRtl ? item.createdBy?.name : item.createdBy?.nameEn,
      fromBranchName: item.transferDetails?.fromBranch ? (isRtl ? item.transferDetails.fromBranch.name : item.transferDetails.fromBranch.nameEn) : null,
      toBranchName: item.transferDetails?.toBranch ? (isRtl ? item.transferDetails.toBranch.name : item.transferDetails.toBranch.nameEn) : null,
    }));

    console.log('جلب سجل المخزون - تم بنجاح:', {
      count: historyItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({
      success: true,
      history: formattedHistory,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Get product details, movements, transfers, and statistics
const getProductDetails = async (req, res) => {
  try {
    const { productId, branchId } = req.params;
    const { page = 1, limit = 10, lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log('جلب تفاصيل المنتج - معرفات غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المنتج أو الفرع غير صالح' : 'Invalid product or branch ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب تفاصيل المنتج - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى تفاصيل هذا الفرع' : 'Unauthorized to access this branch details' });
    }

    const [product, inventory, branch, historyItems, totalItems, returns, transfers] = await Promise.all([
      Product.findById(productId)
        .populate('department', 'name nameEn _id')
        .lean(),
      Inventory.findOne({ product: productId, branch: branchId })
        .populate({
          path: 'product',
          select: 'name nameEn code unit unitEn department',
          populate: { path: 'department', select: 'name nameEn _id' },
        })
        .populate('branch', 'name nameEn')
        .lean(),
      Branch.findById(branchId).lean(),
      InventoryHistory.find({ product: productId, branch: branchId })
        .populate({
          path: 'product',
          select: 'name nameEn code unit unitEn department',
          populate: { path: 'department', select: 'name nameEn _id' },
        })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn')
        .populate('transferDetails.fromBranch', 'name nameEn')
        .populate('transferDetails.toBranch', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean(),
      InventoryHistory.countDocuments({ product: productId, branch: branchId }),
      Return.find({ 'items.product': productId, branch: branchId })
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn code unit unitEn department',
          populate: { path: 'department', select: 'name nameEn _id' },
        })
        .lean(),
      InventoryHistory.find({ product: productId, branch: branchId, type: { $in: ['transfer_in', 'transfer_out'] } })
        .populate('transferDetails.fromBranch', 'name nameEn')
        .populate('transferDetails.toBranch', 'name nameEn')
        .lean(),
    ]);

    if (!product) {
      console.log('جلب تفاصيل المنتج - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }
    if (!branch) {
      console.log('جلب تفاصيل المنتج - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    const formattedProduct = {
      ...product,
      name: isRtl ? product.name : product.nameEn,
      unit: isRtl ? product.unit : product.unitEn,
      departmentName: product.department ? (isRtl ? product.department.name : product.department.nameEn) : null,
    };

    const formattedInventory = inventory ? {
      ...inventory,
      product: inventory.product ? {
        _id: inventory.product._id,
        name: isRtl ? inventory.product.name : inventory.product.nameEn,
        nameEn: inventory.product.nameEn || inventory.product.name,
        code: inventory.product.code || 'N/A',
        unit: isRtl ? inventory.product.unit : inventory.product.unitEn,
        unitEn: inventory.product.unitEn || inventory.product.unit,
        department: inventory.product.department ? {
          _id: inventory.product.department._id,
          name: isRtl ? inventory.product.department.name : inventory.product.department.nameEn,
          nameEn: inventory.product.department.nameEn || inventory.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? inventory.branch?.name : inventory.branch?.nameEn,
      status: inventory.currentStock <= inventory.minStockLevel ? 'low' : inventory.currentStock >= inventory.maxStockLevel ? 'full' : 'normal',
    } : null;

    const movements = historyItems.filter(item => ['restock', 'adjustment', 'return'].includes(item.type));
    const formattedMovements = movements.map(item => ({
      ...item,
      product: item.product ? {
        _id: item.product._id,
        name: isRtl ? item.product.name : item.product.nameEn,
        nameEn: item.product.nameEn || item.product.name,
        code: item.product.code || 'N/A',
        unit: isRtl ? item.product.unit : item.product.unitEn,
        unitEn: item.product.unitEn || item.product.unit,
        department: item.product.department ? {
          _id: item.product.department._id,
          name: isRtl ? item.product.department.name : item.product.department.nameEn,
          nameEn: item.product.department.nameEn || item.product.department.name,
        } : null,
      } : null,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      createdByName: isRtl ? item.createdBy?.name : item.createdBy?.nameEn,
    }));

    const formattedTransfers = transfers.map(item => ({
      ...item,
      fromBranchName: item.transferDetails?.fromBranch ? (isRtl ? item.transferDetails.fromBranch.name : item.transferDetails.fromBranch.nameEn) : null,
      toBranchName: item.transferDetails?.toBranch ? (isRtl ? item.transferDetails.toBranch.name : item.transferDetails.toBranch.nameEn) : null,
    }));

    const formattedReturns = returns.map(ret => ({
      ...ret,
      branchName: isRtl ? ret.branch?.name : ret.branch?.nameEn,
      items: ret.items.map(item => ({
        ...item,
        productName: isRtl ? item.product.name : item.product.nameEn,
        unit: isRtl ? item.product.unit : item.product.unitEn,
        departmentName: item.product.department ? (isRtl ? item.product.department.name : item.product.department.nameEn) : null,
      })),
    }));

    const totalRestocks = historyItems
      .filter(item => item.type === 'restock')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalAdjustments = historyItems
      .filter(item => item.type === 'adjustment')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalReturns = returns
      .reduce((sum, ret) => sum + ret.items.reduce((acc, item) => acc + item.quantity, 0), 0);
    const totalTransfersIn = transfers
      .filter(item => item.type === 'transfer_in')
      .reduce((sum, item) => sum + item.quantity, 0);
    const totalTransfersOut = transfers
      .filter(item => item.type === 'transfer_out')
      .reduce((sum, item) => sum + item.quantity, 0);

    const statistics = {
      totalRestocks,
      totalAdjustments,
      totalReturns,
      totalTransfersIn,
      totalTransfersOut,
      averageStockLevel: inventory ? Math.round((inventory.currentStock / (inventory.maxStockLevel || 1)) * 100) : 0,
      lowStockStatus: inventory && inventory.currentStock <= inventory.minStockLevel,
    };

    console.log('جلب تفاصيل المنتج - تم بنجاح:', {
      productId,
      branchId,
      userId: req.user.id,
      movementsCount: movements.length,
      transfersCount: transfers.length,
    });

    res.status(200).json({
      success: true,
      product: formattedProduct,
      inventory: formattedInventory,
      movements: formattedMovements,
      transfers: formattedTransfers,
      returns: formattedReturns,
      statistics,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب تفاصيل المنتج:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  getInventory,
  getInventoryByBranch,
  createInventory,
  updateStock,
  updateStockLimits,
  bulkCreate,
  createReturn,
  getReturns,
  approveReturn,
  getInventoryHistory,
  getProductDetails,
};