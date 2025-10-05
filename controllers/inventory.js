const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const crypto = require('crypto');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper to format responses based on language
const formatResponse = (data, isRtl, fields = ['name', 'unit', 'departmentName']) => {
  if (Array.isArray(data)) {
    return data.map(item => formatResponse(item, isRtl, fields));
  }
  const formatted = { ...data };
  if (fields.includes('name')) {
    formatted.name = isRtl ? data.name : data.nameEn;
  }
  if (fields.includes('unit') && data.unit) {
    formatted.unit = isRtl ? data.unit : data.unitEn;
  }
  if (fields.includes('departmentName') && data.department) {
    formatted.departmentName = isRtl ? data.department?.name : data.department?.nameEn;
  }
  if (data.branch) {
    formatted.branchName = isRtl ? data.branch?.name : data.branch?.nameEn;
  }
  if (data.createdBy) {
    formatted.createdByName = isRtl ? data.createdBy?.name : data.createdBy?.nameEn;
  }
  if (data.items && Array.isArray(data.items)) {
    formatted.items = data.items.map(item => ({
      ...item,
      productName: isRtl ? item.product?.name : item.product?.nameEn,
      unit: isRtl ? item.product?.unit : item.product?.unitEn,
    }));
  }
  return formatted;
};

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock, lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المخزون - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      query.branch = req.user.branchId;
    }
    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    const inventoryItems = await Inventory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .lean();

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    const formattedItems = formatResponse(filteredItems, isRtl);

    console.log('جلب المخزون - تم بنجاح:', { count: filteredItems.length, userId: req.user.id, query });
    res.status(200).json({ success: true, inventory: formattedItems });
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى مخزون هذا الفرع' : 'Unauthorized to access this branch inventory' });
    }

    const inventoryItems = await Inventory.find({ branch: branchId })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .lean();

    const formattedItems = formatResponse(inventoryItems, isRtl);

    console.log('جلب المخزون حسب الفرع - تم بنجاح:', { count: inventoryItems.length, branchId, userId: req.user.id });
    res.status(200).json({ success: true, inventory: formattedItems });
  } catch (err) {
    console.error('خطأ في جلب المخزون حسب الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Create a single inventory item
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

    const { branchId, productId, currentStock, minStockLevel = 0, maxStockLevel = 1000, lang = 'ar' } = req.body;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(productId)) {
      console.log('إنشاء مخزون - معرفات غير صالحة:', { branchId, productId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع أو المنتج غير صالح' : 'Invalid branch or product ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Unauthorized to create inventory for this branch' });
    }

    const [branch, product, existingInventory] = await Promise.all([
      Branch.findById(branchId).session(session),
      Product.findById(productId).session(session),
      Inventory.findOne({ branch: branchId, product: productId }).session(session),
    ]);

    if (!branch || !product) {
      console.log('إنشاء مخزون - الفرع أو المنتج غير موجود:', { branchId, productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع أو المنتج غير موجود' : 'Branch or product not found' });
    }

    if (existingInventory) {
      console.log('إنشاء مخزون - المخزون موجود مسبقًا:', { branchId, productId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'المخزون موجود مسبقًا لهذا الفرع والمنتج' : 'Inventory already exists for this branch and product' });
    }

    const inventory = new Inventory({
      branch: branchId,
      product: productId,
      currentStock,
      minStockLevel,
      maxStockLevel,
      createdBy: req.user.id,
      movements: currentStock > 0 ? [{
        type: 'in',
        quantity: currentStock,
        reference: 'إنشاء مخزون أولي',
        createdBy: req.user.id,
        createdAt: new Date(),
      }] : [],
    });
    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      action: 'initial',
      quantity: currentStock,
      reference: 'إنشاء مخزون أولي',
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    req.io?.emit('inventoryCreated', {
      branchId,
      productId,
      currentStock,
      eventId: crypto.randomUUID(),
    });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    console.log('إنشاء مخزون - تم بنجاح:', { inventoryId: inventory._id, productId, branchId, userId: req.user.id });
    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: formatResponse(populatedItem, isRtl) });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Bulk create inventory items
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء دفعة مخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, items, lang = 'ar' } = req.body;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId)) {
      console.log('إنشاء دفعة مخزون - معرف الفرع غير صالح:', { branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء دفعة مخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Unauthorized to create inventory for this branch' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('إنشاء دفعة مخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    const productIds = items.map(item => item.productId);
    const orderIds = items.map(item => item.orderId).filter(id => id);
    const [products, orders, existingInventories] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).session(session).lean(),
      Order.find({ _id: { $in: orderIds } }).session(session).lean(),
      Inventory.find({ branch: branchId, product: { $in: productIds } }).session(session).lean(),
    ]);

    if (products.length !== productIds.length) {
      console.log('إنشاء دفعة مخزون - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    if (orderIds.length > 0 && orders.length !== orderIds.length) {
      console.log('إنشاء دفعة مخزون - بعض الطلبات غير موجودة:', { orderIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض الطلبات غير موجودة' : 'Some orders not found' });
    }

    if (orders.some(order => order.status !== 'delivered')) {
      console.log('إنشاء دفعة مخزون - بعض الطلبات ليست في حالة التسليم:', { orderIds });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن تكون جميع الطلبات في حالة "تم التسليم"' : 'All orders must be in "delivered" status' });
    }

    if (existingInventories.length > 0) {
      console.log('إنشاء دفعة مخزون - مخزونات موجودة مسبقًا:', { existingInventories });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بعض المخزونات موجودة مسبقًا' : 'Some inventories already exist' });
    }

    const inventories = items.map(item => ({
      branch: branchId,
      product: item.productId,
      currentStock: item.currentStock || 0,
      minStockLevel: item.minStockLevel || 0,
      maxStockLevel: item.maxStockLevel || 1000,
      createdBy: req.user.id,
      movements: item.currentStock > 0 ? [{
        type: 'in',
        quantity: item.currentStock,
        reference: item.orderId ? `تأكيد تسليم الطلبية #${item.orderId}` : 'إنشاء مخزون بالجملة',
        createdBy: req.user.id,
        createdAt: new Date(),
      }] : [],
    }));

    const createdInventories = await Inventory.insertMany(inventories, { session });

    const historyEntries = items.map(item => ({
      product: item.productId,
      branch: branchId,
      action: 'initial',
      quantity: item.currentStock || 0,
      reference: item.orderId ? `تأكيد تسليم الطلبية #${item.orderId}` : 'إنشاء مخزون بالجملة',
      createdBy: req.user.id,
    }));
    await InventoryHistory.insertMany(historyEntries, { session });

    createdInventories.forEach(inventory => {
      req.io?.emit('inventoryCreated', {
        branchId,
        productId: inventory.product.toString(),
        currentStock: inventory.currentStock,
        eventId: crypto.randomUUID(),
      });
    });

    const populatedItems = await Inventory.find({ _id: { $in: createdInventories.map(inv => inv._id) } })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    console.log('إنشاء دفعة مخزون - تم بنجاح:', { count: createdInventories.length, branchId, userId: req.user.id });
    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: formatResponse(populatedItems, isRtl) });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء دفعة مخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Update inventory stock
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

    const { branchId, productId, quantity, type, lang = 'ar' } = req.body;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !isValidObjectId(productId)) {
      console.log('تحديث المخزون - معرفات غير صالحة:', { branchId, productId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع أو المنتج غير صالح' : 'Invalid branch or product ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('تحديث المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Unauthorized to update inventory for this branch' });
    }

    const inventory = await Inventory.findOne({ branch: branchId, product: productId }).session(session);
    if (!inventory) {
      console.log('تحديث المخزون - المخزون غير موجود:', { branchId, productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المخزون غير موجود' : 'Inventory not found' });
    }

    if (type === 'out' && inventory.currentStock < quantity) {
      console.log('تحديث المخزون - الكمية غير كافية:', { productId, currentStock: inventory.currentStock, requested: quantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الكمية غير كافية في المخزون' : 'Insufficient stock' });
    }

    inventory.currentStock += type === 'in' ? quantity : -quantity;
    inventory.movements.push({
      type,
      quantity: type === 'in' ? quantity : -quantity,
      reference: `تحديث المخزون: ${type}`,
      createdBy: req.user.id,
      createdAt: new Date(),
    });
    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      action: type,
      quantity: type === 'in' ? quantity : -quantity,
      reference: `تحديث المخزون: ${type}`,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      currentStock: inventory.currentStock,
      type,
      eventId: crypto.randomUUID(),
    });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session)
      .lean();

    console.log('تحديث المخزون - تم بنجاح:', { inventoryId: inventory._id, productId, branchId, type, quantity, userId: req.user.id });
    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: formatResponse(populatedItem, isRtl) });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Create return request
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء طلب إرجاع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, items, reason, notes, lang = 'ar' } = req.body;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(branchId) || !items?.length || !reason) {
      console.log('إنشاء طلب إرجاع - بيانات غير صالحة:', { branchId, items, reason });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، العناصر، أو السبب غير صالحة' : 'Invalid branch ID, items, or reason' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء طلب إرجاع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء طلب إرجاع لهذا الفرع' : 'Unauthorized to create return for this branch' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('إنشاء طلب إرجاع - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    const productIds = items.map(item => item.productId);
    const orderIds = items.map(item => item.orderId).filter(id => id);
    const [products, orders, inventories] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).session(session).lean(),
      Order.find({ _id: { $in: orderIds } }).session(session),
      Inventory.find({ branch: branchId, product: { $in: productIds } }).session(session),
    ]);

    if (products.length !== productIds.length) {
      console.log('إنشاء طلب إرجاع - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    if (orderIds.length > 0 && orders.length !== orderIds.length) {
      console.log('إنشاء طلب إرجاع - بعض الطلبات غير موجودة:', { orderIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض الطلبات غير موجودة' : 'Some orders not found' });
    }

    if (orders.some(order => order.status !== 'delivered')) {
      console.log('إنشاء طلب إرجاع - بعض الطلبات ليست في حالة التسليم:', { orderIds });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن تكون جميع الطلبات في حالة "تم التسليم"' : 'All orders must be in "delivered" status' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.productId) || item.quantity < 1 || !item.reason) {
        console.log('إنشاء طلب إرجاع - عنصر غير صالح:', { productId: item.productId, quantity: item.quantity, reason: item.reason });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `عنصر غير صالح: ${item.productId}` : `Invalid item: ${item.productId}` });
      }

      const inventory = inventories.find(inv => inv.product.toString() === item.productId);
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء طلب إرجاع - الكمية غير كافية:', { productId: item.productId, currentStock: inventory?.currentStock, requested: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}` });
      }

      if (item.orderId) {
        const order = orders.find(o => o._id.toString() === item.orderId);
        const orderItem = order?.items.find(i => i.product.toString() === item.productId);
        if (!orderItem || (orderItem.quantity - (orderItem.returnedQuantity || 0)) < item.quantity) {
          console.log('إنشاء طلب إرجاع - الكمية المرتجعة غير صالحة:', {
            productId: item.productId,
            orderQuantity: orderItem?.quantity,
            returnedQuantity: orderItem?.returnedQuantity,
            requested: item.quantity,
          });
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: isRtl ? `الكمية المرتجعة غير صالحة للمنتج ${item.productId}` : `Invalid return quantity for product ${item.productId}` });
        }
      }
    }

    const returnCount = await Return.countDocuments({}).session(session);
    const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(returnCount + 1).padStart(3, '0')}`;
    const returnRequest = new Return({
      returnNumber,
      branch: branchId,
      reason,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason,
        orderId: item.orderId || null,
      })),
      notes: notes?.trim(),
      status: 'pending_approval',
      createdBy: req.user.id,
    });
    await returnRequest.save({ session });

    for (const item of items) {
      const inventory = inventories.find(inv => inv.product.toString() === item.productId);
      inventory.currentStock -= item.quantity;
      inventory.movements.push({
        type: 'out',
        quantity: item.quantity,
        reference: `إرجاع قيد الانتظار #${returnNumber}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
      await inventory.save({ session });

      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: branchId,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `إرجاع قيد الانتظار #${returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      if (item.orderId) {
        const order = orders.find(o => o._id.toString() === item.orderId);
        order.returns.push(returnRequest._id);
        const orderItem = order.items.find(i => i.product.toString() === item.productId);
        orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
        orderItem.returnReason = item.reason;
        await Order.findByIdAndUpdate(order._id, {
          returns: order.returns,
          items: order.items,
        }, { session });
      }
    }

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'name nameEn')
      .session(session)
      .lean();

    req.io?.emit('returnCreated', {
      returnId: returnRequest._id,
      branchId,
      status: 'pending_approval',
      eventId: crypto.randomUUID(),
    });

    console.log('إنشاء طلب إرجاع - تم بنجاح:', { returnId: returnRequest._id, branchId, itemsCount: items.length, userId: req.user.id });
    await session.commitTransaction();
    res.status(201).json({ success: true, returnRequest: formatResponse(populatedReturn, isRtl) });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء طلب إرجاع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

// Process return items
const processReturnItems = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('معالجة عناصر الإرجاع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { returnId } = req.params;
    const { items, lang = 'ar' } = req.body;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(returnId)) {
      console.log('معالجة عناصر الإرجاع - معرف الإرجاع غير صالح:', { returnId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
    }

    const returnRequest = await Return.findById(returnId).session(session);
    if (!returnRequest) {
      console.log('معالجة عناصر الإرجاع - الإرجاع غير موجود:', { returnId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'طلب الإرجاع غير موجود' : 'Return request not found' });
    }

    if (returnRequest.status !== 'pending_approval') {
      console.log('معالجة عناصر الإرجاع - الحالة غير صالحة:', { returnId, status: returnRequest.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن معالجة طلب إرجاع ليس في حالة "قيد الموافقة"' : 'Cannot process return that is not pending approval' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('معالجة عناصر الإرجاع - بعض المنتجات غير موجودة:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    let returnAmount = 0;
    for (const item of items) {
      const returnItem = returnRequest.items.find(i => i.product.toString() === item.productId);
      if (!returnItem || returnItem.quantity !== item.quantity) {
        console.log('معالجة عناصر الإرجاع - عنصر غير متطابق:', { productId: item.productId, quantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `عنصر غير متطابق: ${item.productId}` : `Item mismatch: ${item.productId}` });
      }
      returnItem.status = item.status;
      returnItem.reviewNotes = item.reviewNotes?.trim();

      const product = products.find(p => p._id.toString() === item.productId);
      if (item.status === 'approved') {
        returnAmount += item.quantity * product.price;
      } else if (item.status === 'rejected') {
        const inventory = await Inventory.findOne({ product: item.productId, branch: returnRequest.branch }).session(session);
        if (inventory) {
          inventory.damagedStock = (inventory.damagedStock || 0) + item.quantity;
          inventory.movements.push({
            type: 'damaged',
            quantity: item.quantity,
            reference: `رفض إرجاع #${returnRequest.returnNumber}`,
            createdBy: req.user.id,
            createdAt: new Date(),
          });
          await inventory.save({ session });

          const historyEntry = new InventoryHistory({
            product: item.productId,
            branch: returnRequest.branch,
            action: 'damaged',
            quantity: item.quantity,
            reference: `رفض إرجاع #${returnRequest.returnNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });

          req.io?.emit('inventoryUpdated', {
            branchId: returnRequest.branch.toString(),
            productId: item.productId,
            damagedStock: inventory.damagedStock,
            type: 'damaged',
            eventId: crypto.randomUUID(),
          });
        }
      }
    }

    returnRequest.status = items.every(item => item.status === 'approved') ? 'approved' :
                           items.every(item => item.status === 'rejected') ? 'rejected' : 'partially_processed';
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    await returnRequest.save({ session });

    const orderIds = [...new Set(returnRequest.items.map(item => item.orderId).filter(id => id))];
    for (const orderId of orderIds) {
      const order = await Order.findById(orderId).session(session);
      if (order) {
        for (const item of items) {
          if (item.orderId === orderId) {
            const orderItem = order.items.find(i => i.product.toString() === item.productId);
            if (orderItem && item.status === 'approved') {
              orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
              orderItem.returnReason = returnRequest.items.find(i => i.product.toString() === item.productId)?.reason;
            }
          }
        }
        const returns = await Return.find({ _id: { $in: order.returns }, status: 'approved' }).session(session);
        order.adjustedTotal = order.totalAmount - returns.reduce((sum, ret) => {
          return sum + ret.items.reduce((retSum, retItem) => {
            const orderItem = order.items.find(i => i.product.toString() === retItem.product.toString());
            return retSum + (orderItem && retItem.status === 'approved' ? orderItem.price * retItem.quantity : 0);
          }, 0);
        }, 0);
        await order.save({ session });
      }
    }

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('branch', 'name nameEn')
      .populate({
        path: 'items.product',
        select: 'name nameEn price unit unitEn department',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'name nameEn')
      .populate('reviewedBy', 'name nameEn')
      .session(session)
      .lean();

    req.io?.emit('returnStatusUpdated', {
      returnId: returnRequest._id,
      branchId: returnRequest.branch.toString(),
      status: returnRequest.status,
      eventId: crypto.randomUUID(),
    });

    console.log('معالجة عناصر الإرجاع - تم بنجاح:', { returnId: returnRequest._id, status: returnRequest.status, userId: req.user.id });
    await session.commitTransaction();
    res.status(200).json({ success: true, returnRequest: formatResponse(populatedReturn, isRtl) });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في معالجة عناصر الإرجاع:', { error: err.message, stack: err.stack });
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

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [history, totalItems] = await Promise.all([
      InventoryHistory.find(query)
        .populate('product', 'name nameEn price unit unitEn department')
        .populate({ path: 'product.department', select: 'name nameEn' })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      InventoryHistory.countDocuments(query),
    ]);

    const formattedHistory = formatResponse(history, isRtl);

    console.log('جلب سجل المخزون - تم بنجاح:', { count: history.length, userId: req.user.id, query });
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

// Get product inventory details with history
const getProductInventoryDetails = async (req, res) => {
  try {
    const { productId } = req.params;
    const { branchId, lang = 'ar', page = 1, limit = 10 } = req.query;
    const isRtl = lang === 'ar';

    if (!isValidObjectId(productId) || (branchId && !isValidObjectId(branchId))) {
      console.log('جلب تفاصيل المنتج - معرفات غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المنتج أو الفرع غير صالح' : 'Invalid product or branch ID' });
    }

    if (req.user.role === 'branch' && branchId && branchId !== req.user.branchId?.toString()) {
      console.log('جلب تفاصيل المنتج - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لعرض تفاصيل هذا الفرع' : 'Unauthorized to view details for this branch' });
    }

    const [product, inventory, history, totalHistoryItems] = await Promise.all([
      Product.findById(productId)
        .populate('department', 'name nameEn')
        .lean(),
      branchId ? Inventory.findOne({ product: productId, branch: branchId })
        .populate('branch', 'name nameEn')
        .lean() : Promise.resolve(null),
      InventoryHistory.find({ product: productId, ...(branchId ? { branch: branchId } : {}) })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean(),
      InventoryHistory.countDocuments({ product: productId, ...(branchId ? { branch: branchId } : {}) }),
    ]);

    if (!product) {
      console.log('جلب تفاصيل المنتج - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }

    const formattedProduct = {
      ...product,
      inventory: inventory ? {
        ...inventory,
        branchName: isRtl ? inventory.branch?.name : inventory.branch?.nameEn,
      } : null,
      history: formatResponse(history, isRtl, ['name', 'unit']),
      totalHistoryPages: Math.ceil(totalHistoryItems / parseInt(limit)),
      currentHistoryPage: parseInt(page),
    };

    console.log('جلب تفاصيل المنتج - تم بنجاح:', { productId, branchId, userId: req.user.id });
    res.status(200).json({ success: true, product: formatResponse(formattedProduct, isRtl) });
  } catch (err) {
    console.error('خطأ في جلب تفاصيل المنتج:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  getInventory,
  getInventoryByBranch,
  createInventory,
  bulkCreate,
  updateStock,
  createReturn,
  processReturnItems,
  getInventoryHistory,
  getProductInventoryDetails,
};