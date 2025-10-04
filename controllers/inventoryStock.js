const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const InventoryHistory = require('../models/InventoryHistory');
const { isValidObjectId } = mongoose;

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const query = {};
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    }
    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المخزون - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [inventoryItems, totalItems] = await Promise.all([
      Inventory.find(query)
        .populate('product', 'name nameEn price unit unitEn department')
        .populate({ path: 'product.department', select: 'name nameEn' })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments(query),
    ]);

    const formattedInventory = inventoryItems.map(item => ({
      ...item,
      productName: isRtl ? item.product?.name : item.product?.nameEn,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      unit: isRtl ? item.product?.unit : item.product?.unitEn,
      departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn,
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId)) {
      console.log('جلب مخزون الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب مخزون الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [inventoryItems, totalItems] = await Promise.all([
      Inventory.find({ branch: branchId })
        .populate('product', 'name nameEn price unit unitEn department')
        .populate({ path: 'product.department', select: 'name nameEn' })
        .populate('branch', 'name nameEn')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Inventory.countDocuments({ branch: branchId }),
    ]);

    const formattedInventory = inventoryItems.map(item => ({
      ...item,
      productName: isRtl ? item.product?.name : item.product?.nameEn,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      unit: isRtl ? item.product?.unit : item.product?.unitEn,
      departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn,
    }));

    console.log('جلب مخزون الفرع - تم بنجاح:', {
      branchId,
      count: inventoryItems.length,
      userId: req.user.id,
    });

    res.status(200).json({
      success: true,
      inventory: formattedInventory,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page),
    });
  } catch (err) {
    console.error('خطأ في جلب مخزون الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create a new inventory entry
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { branchId, productId, currentStock, minStockLevel = 0, maxStockLevel = 1000 } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(productId)) {
      console.log('إنشاء مخزون - معرفات غير صالحة:', { branchId, productId });
      return res.status(400).json({ success: false, message: 'معرف الفرع أو المنتج غير صالح' });
    }

    if (currentStock < 0) {
      console.log('إنشاء مخزون - كمية غير صالحة:', { currentStock });
      return res.status(400).json({ success: false, message: 'كمية المخزون لا يمكن أن تكون سالبة' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session).lean(),
      Branch.findById(branchId).session(session).lean(),
    ]);

    if (!product) {
      console.log('إنشاء مخزون - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log('إنشاء مخزون - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    const existingInventory = await Inventory.findOne({ product: productId, branch: branchId }).session(session);
    if (existingInventory) {
      console.log('إنشاء مخزون - المخزون موجود مسبقًا:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'المخزون موجود مسبقًا لهذا المنتج والفرع' });
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
      reference: `إنشاء مخزون جديد بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: currentStock,
      type: 'restock',
      reference: `إنشاء مخزون جديد`,
    });

    const populatedInventory = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    const formattedInventory = {
      ...populatedInventory,
      productName: isRtl ? populatedInventory.product?.name : populatedInventory.product?.nameEn,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
      unit: isRtl ? populatedInventory.product?.unit : populatedInventory.product?.unitEn,
      departmentName: isRtl ? populatedInventory.product?.department?.name : populatedInventory.product?.department?.nameEn,
    };

    console.log('إنشاء مخزون - تم بنجاح:', { inventoryId: inventory._id, userId: req.user.id });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: formattedInventory });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Update stock for an inventory entry
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { currentStock } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id)) {
      console.log('تحديث المخزون - معرف المخزون غير صالح:', { id });
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    if (currentStock < 0) {
      console.log('تحديث المخزون - كمية غير صالحة:', { currentStock });
      return res.status(400).json({ success: false, message: 'كمية المخزون لا يمكن أن تكون سالبة' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث المخزون - المخزون غير موجود:', { id });
      return res.status(404).json({ success: false, message: 'المخزون غير موجود' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    const oldStock = inventory.currentStock;
    inventory.currentStock = currentStock;
    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      product: inventory.product,
      branch: inventory.branch,
      type: currentStock > oldStock ? 'restock' : 'adjustment',
      quantity: Math.abs(currentStock - oldStock),
      reference: `تحديث المخزون بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      quantity: currentStock,
      type: currentStock > oldStock ? 'restock' : 'adjustment',
      reference: `تحديث المخزون`,
    });

    const populatedInventory = await Inventory.findById(id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    const formattedInventory = {
      ...populatedInventory,
      productName: isRtl ? populatedInventory.product?.name : populatedInventory.product?.nameEn,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
      unit: isRtl ? populatedInventory.product?.unit : populatedInventory.product?.unitEn,
      departmentName: isRtl ? populatedInventory.product?.department?.name : populatedInventory.product?.department?.nameEn,
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Update stock limits for an inventory entry
const updateStockLimits = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { minStockLevel, maxStockLevel } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id)) {
      console.log('تحديث حدود المخزون - معرف المخزون غير صالح:', { id });
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    if (minStockLevel < 0 || maxStockLevel < minStockLevel) {
      console.log('تحديث حدود المخزون - حدود غير صالحة:', { minStockLevel, maxStockLevel });
      return res.status(400).json({ success: false, message: 'حدود المخزون غير صالحة' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث حدود المخزون - المخزون غير موجود:', { id });
      return res.status(404).json({ success: false, message: 'المخزون غير موجود' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث حدود المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث حدود مخزون هذا الفرع' });
    }

    inventory.minStockLevel = minStockLevel;
    inventory.maxStockLevel = maxStockLevel;
    await inventory.save({ session });

    const populatedInventory = await Inventory.findById(id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    const formattedInventory = {
      ...populatedInventory,
      productName: isRtl ? populatedInventory.product?.name : populatedInventory.product?.nameEn,
      branchName: isRtl ? populatedInventory.branch?.name : populatedInventory.branch?.nameEn,
      unit: isRtl ? populatedInventory.product?.unit : populatedInventory.product?.unitEn,
      departmentName: isRtl ? populatedInventory.product?.department?.name : populatedInventory.product?.department?.nameEn,
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Bulk create inventory entries
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { branchId, items, orderId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !Array.isArray(items) || items.length === 0) {
      console.log('إنشاء مخزون بالجملة - بيانات غير صالحة:', { branchId, itemsCount: items?.length });
      return res.status(400).json({ success: false, message: 'معرف الفرع أو العناصر غير صالحة' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.currentStock < 0)) {
      console.log('إنشاء مخزون بالجملة - عناصر غير صالحة:', { items });
      return res.status(400).json({ success: false, message: 'معرفات المنتجات أو الكميات غير صالحة' });
    }

    if (orderId && !isValidObjectId(orderId)) {
      console.log('إنشاء مخزون بالجملة - معرف الطلب غير صالح:', { orderId });
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مخزون بالجملة - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    const branch = await Branch.findById(branchId).session(session).lean();
    if (!branch) {
      console.log('إنشاء مخزون بالجملة - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('إنشاء مخزون بالجملة - بعض المنتجات غير موجودة:', { productIds });
      return res.status(404).json({ success: false, message: 'بعض المنتجات غير موجودة' });
    }

    const existingInventories = await Inventory.find({ branch: branchId, product: { $in: productIds } }).session(session);
    if (existingInventories.length > 0) {
      console.log('إنشاء مخزون بالجملة - مخزون موجود مسبقًا:', { existing: existingInventories.map(inv => inv.product.toString()) });
      return res.status(400).json({ success: false, message: 'مخزون موجود مسبقًا لبعض المنتجات في هذا الفرع' });
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
      reference: orderId ? `إنشاء مخزون بالجملة لطلب ${orderId} بواسطة ${req.user.username}` : `إنشاء مخزون بالجملة بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    }));
    await InventoryHistory.insertMany(historyEntries, { session });

    for (const item of items) {
      req.io?.emit('inventoryUpdated', {
        branchId,
        productId: item.productId,
        quantity: item.currentStock,
        type: 'restock',
        reference: orderId ? `إنشاء مخزون بالجملة لطلب ${orderId}` : `إنشاء مخزون بالجملة`,
      });
    }

    const populatedInventories = await Inventory.find({ _id: { $in: savedInventories.map(inv => inv._id) } })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    const formattedInventories = populatedInventories.map(item => ({
      ...item,
      productName: isRtl ? item.product?.name : item.product?.nameEn,
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn,
      unit: isRtl ? item.product?.unit : item.product?.unitEn,
      departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn,
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  getInventory,
  getInventoryByBranch,
  createInventory,
  updateStock,
  updateStockLimits,
  bulkCreate,
};