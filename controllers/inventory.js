const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const { isValidObjectId } = mongoose;

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    const query = {};
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    }
    if (product && isValidObjectId(product)) {
      query.product = product;
    }
    if (lowStock === 'true') {
      query.currentStock = { $lte: mongoose.ref('minStockLevel') };
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
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { page = 1, limit = 10, search, lowStock } = req.query;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId)) {
      console.log('جلب مخزون الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب مخزون الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى مخزون هذا الفرع' : 'Unauthorized to access this branch inventory' });
    }

    const query = { branch: branchId };
    if (lowStock === 'true') {
      query.currentStock = { $lte: mongoose.ref('minStockLevel') };
    }
    if (search) {
      const productIds = await Product.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { nameEn: { $regex: search, $options: 'i' } },
        ],
      }).distinct('_id');
      query.product = { $in: productIds };
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

    console.log('جلب مخزون الفرع - تم بنجاح:', {
      branchId,
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
    console.error('خطأ في جلب مخزون الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Create a new inventory entry
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { branchId, productId, currentStock, minStockLevel = 0, maxStockLevel = 1000, userId, orderId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || (orderId && !isValidObjectId(orderId))) {
      console.log('إنشاء مخزون - معرفات غير صالحة:', { branchId, productId, userId, orderId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، المنتج، أو المستخدم غير صالح' : 'Invalid branch, product, or user ID' });
    }

    if (currentStock < 0) {
      console.log('إنشاء مخزون - كمية غير صالحة:', { currentStock });
      return res.status(400).json({ success: false, message: isRtl ? 'كمية المخزون لا يمكن أن تكون سالبة' : 'Stock quantity cannot be negative' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Unauthorized to create inventory for this branch' });
    }

    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session).lean(),
      Branch.findById(branchId).session(session).lean(),
    ]);

    if (!product) {
      console.log('إنشاء مخزون - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }
    if (!branch) {
      console.log('إنشاء مخزون - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    const existingInventory = await Inventory.findOne({ product: productId, branch: branchId }).session(session);
    if (existingInventory) {
      console.log('إنشاء مخزون - المخزون موجود مسبقًا:', { productId, branchId });
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
      reference: orderId ? `إنشاء مخزون جديد لطلب ${orderId} بواسطة ${req.user.username}` : `إنشاء مخزون جديد بواسطة ${req.user.username}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: currentStock,
      type: 'restock',
      reference: orderId ? `إنشاء مخزون جديد لطلب ${orderId}` : `إنشاء مخزون جديد`,
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
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
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
    const { currentStock, minStockLevel, maxStockLevel } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(id)) {
      console.log('تحديث المخزون - معرف المخزون غير صالح:', { id });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المخزون غير صالح' : 'Invalid inventory ID' });
    }

    if (currentStock !== undefined && currentStock < 0) {
      console.log('تحديث المخزون - كمية غير صالحة:', { currentStock });
      return res.status(400).json({ success: false, message: isRtl ? 'كمية المخزون لا يمكن أن تكون سالبة' : 'Stock quantity cannot be negative' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث المخزون - المخزون غير موجود:', { id });
      return res.status(404).json({ success: false, message: isRtl ? 'المخزون غير موجود' : 'Inventory not found' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Unauthorized to update this branch inventory' });
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
    }

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
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
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
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المخزون غير صالح' : 'Invalid inventory ID' });
    }

    if (minStockLevel < 0 || maxStockLevel < minStockLevel) {
      console.log('تحديث حدود المخزون - حدود غير صالحة:', { minStockLevel, maxStockLevel });
      return res.status(400).json({ success: false, message: isRtl ? 'حدود المخزون غير صالحة' : 'Invalid stock limits' });
    }

    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      console.log('تحديث حدود المخزون - المخزون غير موجود:', { id });
      return res.status(404).json({ success: false, message: isRtl ? 'المخزون غير موجود' : 'Inventory not found' });
    }

    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      console.log('تحديث حدود المخزون - غير مخول:', { userId: req.user.id, branchId: inventory.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث حدود مخزون هذا الفرع' : 'Unauthorized to update this branch inventory limits' });
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
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Bulk create inventory entries
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { branchId, items, orderId, userId } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || items.length === 0) {
      console.log('إنشاء مخزون بالجملة - بيانات غير صالحة:', { branchId, userId, itemsCount: items?.length });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، المستخدم، أو العناصر غير صالحة' : 'Invalid branch ID, user ID, or items' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.currentStock < 0)) {
      console.log('إنشاء مخزون بالجملة - عناصر غير صالحة:', { items });
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات أو الكميات غير صالحة' : 'Invalid product IDs or quantities' });
    }

    if (orderId && !isValidObjectId(orderId)) {
      console.log('إنشاء مخزون بالجملة - معرف الطلب غير صالح:', { orderId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مخزون بالجملة - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Unauthorized to create inventory for this branch' });
    }

    const branch = await Branch.findById(branchId).session(session).lean();
    if (!branch) {
      console.log('إنشاء مخزون بالجملة - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('إنشاء مخزون بالجملة - بعض المنتجات غير موجودة:', { productIds });
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    const existingInventories = await Inventory.find({ branch: branchId, product: { $in: productIds } }).session(session);
    if (existingInventories.length > 0) {
      console.log('إنشاء مخزون بالجملة - مخزون موجود مسبقًا:', { existing: existingInventories.map(inv => inv.product.toString()) });
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
      reference: orderId ? `إنشاء مخزون بالجملة لطلب ${orderId} بواسطة ${req.user.username}` : `إنشاء مخزون بالجملة بواسطة ${req.user.username}`,
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
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Create a return request
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { orderId, branchId, reason, items, notes } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(orderId) || !isValidObjectId(branchId) || !reason || !Array.isArray(items) || items.length === 0) {
      console.log('إنشاء مرتجع - بيانات غير صالحة:', { orderId, branchId, reason, itemsCount: items?.length });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب، الفرع، السبب، أو العناصر غير صالحة' : 'Invalid order ID, branch ID, reason, or items' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.quantity < 1 || !item.reason)) {
      console.log('إنشاء مرتجع - عناصر غير صالحة:', { items });
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات، الكميات، أو الأسباب غير صالحة' : 'Invalid product IDs, quantities, or reasons' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مرتجع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مرتجع لهذا الفرع' : 'Unauthorized to create return for this branch' });
    }

    const [branch, products] = await Promise.all([
      Branch.findById(branchId).session(session).lean(),
      Product.find({ _id: { $in: items.map(item => item.productId) } }).session(session).lean(),
    ]);

    if (!branch) {
      console.log('إنشاء مرتجع - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }
    if (products.length !== items.length) {
      console.log('إنشاء مرتجع - بعض المنتجات غير موجودة:', { productIds: items.map(item => item.productId) });
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    const returnRequest = new Return({
      orderId,
      branch: branchId,
      reason,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason,
      })),
      notes,
      createdBy: req.user.id,
      status: 'pending_approval',
      returnNumber: `RET-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    });
    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'name nameEn')
      .session(session)
      .lean();

    const formattedReturn = {
      ...populatedReturn,
      branchName: isRtl ? populatedReturn.branch?.name : populatedReturn.branch?.nameEn,
      items: populatedReturn.items.map(item => ({
        ...item,
        productName: isRtl ? item.product.name : item.product.nameEn,
        unit: isRtl ? item.product.unit : item.product.unitEn,
        departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn,
      })),
      createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn,
    };

    req.io?.to(`branch-${branchId}`).emit('returnCreated', {
      returnId: returnRequest._id,
      branchId,
      status: returnRequest.status,
      items: formattedReturn.items,
    });

    console.log('إنشاء مرتجع - تم بنجاح:', {
      returnId: returnRequest._id,
      userId: req.user.id,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, returnRequest: formattedReturn });
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
    const { branchId, status, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
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
        .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
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
        departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn,
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
  session.startTransaction();
  try {
    const { id: returnId } = req.params;
    const { status, items, reviewNotes } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(returnId) || !['approved', 'rejected'].includes(status) || !Array.isArray(items) || items.length === 0) {
      console.log('الموافقة على المرتجع - بيانات غير صالحة:', { returnId, status, itemsCount: items?.length });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المرتجع، الحالة، أو العناصر غير صالحة' : 'Invalid return ID, status, or items' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.quantity < 1 || !['approved', 'rejected'].includes(item.status))) {
      console.log('الموافقة على المرتجع - عناصر غير صالحة:', { items });
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات، الكميات، أو الحالات غير صالحة' : 'Invalid product IDs, quantities, or statuses' });
    }

    const returnRequest = await Return.findById(returnId).session(session);
    if (!returnRequest) {
      console.log('الموافقة على المرتجع - المرتجع غير موجود:', { returnId });
      return res.status(404).json({ success: false, message: isRtl ? 'المرتجع غير موجود' : 'Return not found' });
    }

    if (req.user.role === 'branch' && returnRequest.branch.toString() !== req.user.branchId?.toString()) {
      console.log('الموافقة على المرتجع - غير مخول:', { userId: req.user.id, branchId: returnRequest.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لمعالجة مرتجع هذا الفرع' : 'Unauthorized to process return for this branch' });
    }

    if (returnRequest.status !== 'pending_approval') {
      console.log('الموافقة على المرتجع - الحالة غير صالحة:', { returnId, currentStatus: returnRequest.status });
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن معالجة مرتجع ليس بحالة قيد الانتظار' : 'Cannot process return that is not pending' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('الموافقة على المرتجع - بعض المنتجات غير موجودة:', { productIds });
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
        return res.status(400).json({ success: false, message: isRtl ? 'عنصر المرتجع غير متطابق' : 'Return item mismatch' });
      }
      returnItem.status = item.status;
      returnItem.reviewNotes = item.reviewNotes;

      if (item.status === 'approved') {
        const inventory = await Inventory.findOne({ product: item.productId, branch: returnRequest.branch }).session(session);
        if (!inventory) {
          console.log('الموافقة على المرتجع - المخزون غير موجود:', { productId: item.productId, branchId: returnRequest.branch });
          return res.status(404).json({ success: false, message: isRtl ? 'المخزون غير موجود لهذا المنتج' : 'Inventory not found for this product' });
        }
        inventory.currentStock += item.quantity;
        await inventory.save({ session });

        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: returnRequest.branch,
          type: 'return',
          quantity: item.quantity,
          reference: `موافقة مرتجع ${returnRequest.returnNumber} بواسطة ${req.user.username}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: returnRequest.branch.toString(),
          productId: item.productId,
          quantity: inventory.currentStock,
          type: 'return',
          reference: `موافقة مرتجع ${returnRequest.returnNumber}`,
        });
      }
    }

    await returnRequest.save({ session });

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
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
        departmentName: isRtl ? item.product.department?.name : item.product.department?.nameEn,
      })),
      createdByName: isRtl ? populatedReturn.createdBy?.name : populatedReturn.createdBy?.nameEn,
      reviewedByName: isRtl ? populatedReturn.reviewedBy?.name : populatedReturn.reviewedBy?.nameEn,
    };

    req.io?.to(`branch-${returnRequest.branch.toString()}`).emit('returnUpdated', {
      returnId: returnRequest._id,
      branchId: returnRequest.branch.toString(),
      status,
      items: formattedReturn.items,
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
    const { branchId, productId, page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
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
        .populate('product', 'name nameEn unit unitEn')
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
      productName: isRtl ? item.product?.name : item.product?.nameEn,
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
    const { page = 1, limit = 10 } = req.query;
    const lang = req.query.lang || 'ar';
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
        .populate('department', 'name nameEn')
        .lean(),
      Inventory.findOne({ product: productId, branch: branchId })
        .populate('product', 'name nameEn price unit unitEn department')
        .populate({ path: 'product.department', select: 'name nameEn' })
        .populate('branch', 'name nameEn')
        .lean(),
      Branch.findById(branchId).lean(),
      InventoryHistory.find({ product: productId, branch: branchId })
        .populate('product', 'name nameEn unit unitEn')
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
        .populate({ path: 'items.product', select: 'name nameEn unit unitEn' })
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

    const movements = historyItems.filter(item => ['restock', 'adjustment', 'return'].includes(item.type));
    const formattedMovements = movements.map(item => ({
      ...item,
      productName: isRtl ? item.product?.name : item.product?.nameEn,
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
      product: {
        ...product,
        name: isRtl ? product.name : product.nameEn,
        unit: isRtl ? product.unit : product.unitEn,
        departmentName: isRtl ? product.department?.name : product.department?.nameEn,
      },
      inventory: inventory ? {
        ...inventory,
        productName: isRtl ? inventory.product?.name : inventory.product?.nameEn,
        branchName: isRtl ? inventory.branch?.name : inventory.branch?.nameEn,
        departmentName: isRtl ? inventory.product?.department?.name : inventory.product?.department?.nameEn,
      } : null,
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