// controllers/inventory.js
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const RestockRequest = require('../models/RestockRequest');
const User = require('../models/User');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create or update inventory item
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 0, maxStockLevel = 1000, orderId } = req.body;

    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product || !branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج أو الفرع غير موجود' });
    }

    let order = null;
    if (orderId) {
      order = await Order.findById(orderId).session(session);
      if (!order || order.status !== 'delivered') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'الطلب غير صالح أو لم يتم تسليمه' });
      }
    }

    const reference = orderId ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}` : `إنشاء مخزون بواسطة ${req.user.username}`;

    const inventory = await Inventory.findOneAndUpdate(
      { branch: branchId, product: productId },
      {
        $setOnInsert: {
          product: productId,
          branch: branchId,
          minStockLevel,
          maxStockLevel,
          createdBy: userId,
        },
        $inc: { currentStock },
        $push: {
          movements: {
            type: 'in',
            quantity: currentStock,
            reference,
            createdBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { upsert: true, new: true, session }
    );

    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      type: 'restock',
      quantity: currentStock,
      reference,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session);

    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: populatedItem.toObject({ virtuals: true }) });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Bulk create or update inventory items
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, userId, orderId, items } = req.body;

    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول' });
    }

    const [branch, order] = await Promise.all([
      Branch.findById(branchId).session(session),
      orderId ? Order.findById(orderId).session(session) : null,
    ]);
    if (!branch || (orderId && (!order || order.status !== 'delivered'))) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الفرع أو الطلب غير صالح' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'بعض المنتجات غير موجودة' });
    }

    const reference = orderId ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}` : `إنشاء دفعة مخزون بواسطة ${req.user.username}`;

    const inventories = [];
    const historyEntries = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 0, maxStockLevel = 1000 } = item;
      if (currentStock < 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير صالحة للمنتج ${productId}` });
      }

      const inventory = await Inventory.findOneAndUpdate(
        { branch: branchId, product: productId },
        {
          $setOnInsert: {
            product: productId,
            branch: branchId,
            minStockLevel,
            maxStockLevel,
            createdBy: userId,
          },
          $inc: { currentStock },
          $push: {
            movements: {
              type: 'in',
              quantity: currentStock,
              reference,
              createdBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { upsert: true, new: true, session }
      );

      inventories.push(inventory);

      historyEntries.push(new InventoryHistory({
        product: productId,
        branch: branchId,
        type: 'restock',
        quantity: currentStock,
        reference,
        createdBy: userId,
      }));

      req.io?.emit('inventoryUpdated', {
        branchId,
        productId,
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
      });
    }

    await InventoryHistory.insertMany(historyEntries, { session });

    const populatedItems = await Inventory.find({ _id: { $in: inventories.map(inv => inv._id) } })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session);

    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: populatedItems.map(item => item.toObject({ virtuals: true })) });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock } = req.query;
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      query.branch = req.user.branchId;
    }

    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    const inventoryItems = await Inventory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn');

    let filteredItems = inventoryItems.map(item => item.toObject({ virtuals: true }));

    if (lowStock === 'true') {
      filteredItems = filteredItems.filter(item => item.currentStock <= item.minStockLevel);
    }

    res.status(200).json({ success: true, inventory: filteredItems });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;

    if (!isValidObjectId(branchId)) {
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      return res.status(403).json({ success: false, message: 'غير مخول' });
    }

    const inventoryItems = await Inventory.find({ branch: branchId })
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn');

    res.status(200).json({ success: true, inventory: inventoryItems.map(item => item.toObject({ virtuals: true })) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update inventory stock
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

    let inventory;
    if (id) {
      inventory = await Inventory.findById(id).session(session);
      if (!inventory) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
      }
      const oldStock = inventory.currentStock;
      inventory.currentStock = currentStock !== undefined ? currentStock : inventory.currentStock;
      inventory.minStockLevel = minStockLevel !== undefined ? minStockLevel : inventory.minStockLevel;
      inventory.maxStockLevel = maxStockLevel !== undefined ? maxStockLevel : inventory.maxStockLevel;
      inventory.movements.push({
        type: currentStock > oldStock ? 'in' : 'out',
        quantity: Math.abs(currentStock - oldStock),
        reference: `تحديث المخزون بواسطة ${req.user.username}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
      await inventory.save({ session });
    } else {
      // Create new
      if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان' });
      }
      inventory = new Inventory({
        product: productId,
        branch: branchId,
        currentStock: currentStock || 0,
        minStockLevel: minStockLevel || 0,
        maxStockLevel: maxStockLevel || 1000,
        createdBy: req.user.id,
        movements: [{
          type: 'in',
          quantity: currentStock || 0,
          reference: `إنشاء مخزون بواسطة ${req.user.username}`,
          createdBy: req.user.id,
          createdAt: new Date(),
        }],
      });
      await inventory.save({ session });
    }

    const historyEntry = new InventoryHistory({
      product: inventory.product,
      branch: inventory.branch,
      action: id ? 'adjustment' : 'restock',
      quantity: currentStock || 0,
      reference: `تحديث المخزون بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .session(session);

    req.io?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      quantity: inventory.currentStock,
      type: id ? 'adjustment' : 'restock',
    });

    await session.commitTransaction();
    res.status(id ? 200 : 201).json({ success: true, inventory: populatedItem.toObject({ virtuals: true }) });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Create restock request
const createRestockRequest = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId, requestedQuantity, notes } = req.body;

    if (!isValidObjectId(productId) || !isValidObjectId(branchId) || requestedQuantity < 1) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج، الفرع، أو الكمية المطلوبة غير صالحة' });
    }

    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product || !branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج أو الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إعادة تخزين لهذا الفرع' });
    }

    const restockRequest = new RestockRequest({
      product: productId,
      branch: branchId,
      requestedQuantity,
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await restockRequest.save({ session });

    const populatedRequest = await RestockRequest.findById(restockRequest._id)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .session(session);

    req.io?.emit('restockRequested', {
      requestId: restockRequest._id,
      branchId,
      productId,
      requestedQuantity,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, restockRequest: populatedRequest.toObject({ virtuals: true }) });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Approve restock request
const approveRestockRequest = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { requestId } = req.params;
    const { approvedQuantity, userId } = req.body;

    if (!isValidObjectId(requestId) || !isValidObjectId(userId) || approvedQuantity < 1) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب، المستخدم، أو الكمية المعتمدة غير صالحة' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const restockRequest = await RestockRequest.findById(requestId).session(session);
    if (!restockRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب إعادة التخزين غير موجود' });
    }

    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = userId;
    restockRequest.approvedAt = new Date();
    await restockRequest.save({ session });

    const inventory = await Inventory.findOneAndUpdate(
      { product: restockRequest.product, branch: restockRequest.branch },
      {
        $setOnInsert: {
          product: restockRequest.product,
          branch: restockRequest.branch,
          minStockLevel: 0,
          maxStockLevel: 1000,
          createdBy: userId,
        },
        $inc: { currentStock: approvedQuantity },
        $push: {
          movements: {
            type: 'in',
            quantity: approvedQuantity,
            reference: `إعادة تخزين معتمدة #${restockRequest._id} بواسطة ${req.user.username}`,
            createdBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { upsert: true, new: true, session }
    );

    const historyEntry = new InventoryHistory({
      product: restockRequest.product,
      branch: restockRequest.branch,
      action: 'restock',
      quantity: approvedQuantity,
      reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    const populatedRequest = await RestockRequest.findById(requestId)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .populate('approvedBy', 'username')
      .session(session);

    req.io?.emit('restockApproved', {
      requestId,
      branchId: restockRequest.branch.toString(),
      productId: restockRequest.product.toString(),
      quantity: approvedQuantity,
    });
    req.io?.emit('inventoryUpdated', {
      branchId: restockRequest.branch.toString(),
      productId: restockRequest.product.toString(),
      quantity: inventory.currentStock,
      type: 'restock',
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, restockRequest: populatedRequest.toObject({ virtuals: true }) });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all restock requests
const getRestockRequests = async (req, res) => {
  try {
    const { branchId } = req.query;
    const query = {};

    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      query.branch = req.user.branchId;
    }

    const restockRequests = await RestockRequest.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, restockRequests: restockRequests.map(r => r.toObject({ virtuals: true })) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const { branchId, productId } = req.query;
    const query = {};

    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      query.branch = req.user.branchId;
    }

    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }

    const history = await InventoryHistory.find(query)
      .populate('product', 'name nameEn price unit unitEn department')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, history: history.map(h => h.toObject({ virtuals: true })) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create a return request
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { orderId, items, reason, notes, branchId } = req.body;

    if (!isValidObjectId(branchId) || !items?.length || !reason) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، العناصر، أو السبب غير صالحة' });
    }

    let order = null;
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
      }
      order = await Order.findById(orderId).populate('branch').session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب في حالة "تم التسليم"' });
      }
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إرجاع لهذا الفرع' });
    }

    // Validate items
    for (const item of items) {
      if (!isValidObjectId(item.productId) || item.quantity < 1 || !item.reason) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `عنصر غير صالح: ${item.productId}` });
      }

      const product = await Product.findById(item.productId).session(session);
      if (!product) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: `المنتج ${item.productId} غير موجود` });
      }

      const inventoryItem = await Inventory.findOne({ product: item.productId, branch: branchId }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `الكمية غير كافية للمنتج ${item.productId}` });
      }

      if (orderId) {
        const orderItem = order.items.find(i => i.product.toString() === item.productId);
        if (!orderItem || (orderItem.quantity - orderItem.returnedQuantity) < item.quantity) {
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: `الكمية المرتجعة غير صالحة للمنتج ${item.productId}` });
        }
      }
    }

    const returnNumber = `RET-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const returnRequest = new Return({
      returnNumber,
      order: orderId || null,
      branch: branchId,
      reason,
      items: items.map(item => ({
        itemId: orderId ? order.items.find(i => i.product.toString() === item.productId)?._id : null,
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason,
      })),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await returnRequest.save({ session });

    // Update inventory and order items if applicable
    for (const item of items) {
      await Inventory.findOneAndUpdate(
        { product: item.productId, branch: branchId },
        {
          $inc: { currentStock: -item.quantity },
          $push: {
            movements: {
              type: 'out',
              quantity: item.quantity,
              reference: `إرجاع #${returnNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        },
        { session }
      );

      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: branchId,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `إرجاع #${returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      if (orderId) {
        const orderItem = order.items.find(i => i.product.toString() === item.productId);
        if (orderItem) {
          orderItem.returnedQuantity = (orderItem.returnedQuantity || 0) + item.quantity;
          orderItem.returnReason = item.reason;
        }
      }
    }

    if (orderId) {
      order.returns.push(returnRequest._id);
      await order.save({ session });
    }

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('order', 'orderNumber')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session);

    req.io?.emit('returnCreated', {
      returnId: returnRequest._id,
      branchId,
      orderId,
      orderNumber: order?.orderNumber,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, returnRequest: populatedReturn.toObject({ virtuals: true }) });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { returnId } = req.params;
    const { branchId, items } = req.body;

    if (!isValidObjectId(returnId) || !isValidObjectId(branchId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    }

    const returnRequest = await Return.findById(returnId).session(session);
    if (!returnRequest) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب الإرجاع غير موجود' });
    }

    let order = null;
    if (returnRequest.order) {
      order = await Order.findById(returnRequest.order).session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
    }

    returnRequest.items = returnRequest.items.map(returnItem => {
      const updatedItem = items.find(item => item.productId === returnItem.product.toString());
      if (updatedItem) {
        return {
          ...returnItem.toObject(),
          status: updatedItem.status,
          reviewNotes: updatedItem.reviewNotes?.trim(),
        };
      }
      return returnItem;
    });

    const allApproved = returnRequest.items.every(i => i.status === 'approved');
    const allRejected = returnRequest.items.every(i => i.status === 'rejected');
    returnRequest.status = allRejected ? 'rejected' :
                           allApproved ? 'approved' :
                           'partially_processed';
    await returnRequest.save({ session });

    for (const item of items) {
      if (item.status === 'rejected') {
        // Add back if rejected
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.productId, branch: branchId },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `رفض إرجاع #${returnRequest.returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );

        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: branchId,
          action: 'return_rejected',
          quantity: item.quantity,
          reference: `رفض إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId,
          productId: item.productId,
          quantity: inventory.currentStock,
          type: 'return_rejected',
        });
      } else if (item.status === 'approved') {
        // No inventory change for approved (already deducted on create)
        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: branchId,
          action: 'return_approved',
          quantity: -item.quantity,
          reference: `معالجة إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        if (order) {
          const orderItem = order.items.find(i => i.product.toString() === item.productId);
          if (orderItem) {
            orderItem.returnedQuantity += item.quantity;
            orderItem.returnReason = returnRequest.items.find(ri => ri.product.toString() === item.productId)?.reason;
          }
        }
      }
    }

    if (order) {
      const returns = await Return.find({ _id: { $in: order.returns }, status: 'approved' }).session(session);
      const returnAdjustments = returns.reduce((sum, ret) => sum + ret.items.reduce((retSum, item) => {
        const orderItem = order.items.find(i => i._id.toString() === item.itemId?.toString());
        return retSum + (orderItem ? orderItem.price * item.quantity : 0);
      }, 0), 0);
      order.adjustedTotal = order.totalAmount - returnAdjustments;
      await order.save({ session });
    }

    const populatedReturn = await Return.findById(returnId)
      .populate('order', 'orderNumber')
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session);

    req.io?.emit('returnStatusUpdated', {
      returnId,
      branchId,
      orderId: returnRequest.order,
      status: returnRequest.status,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, returnRequest: populatedReturn.toObject({ virtuals: true }) });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createInventory,
  bulkCreate,
  getInventory,
  getInventoryByBranch,
  updateStock,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createReturn,
  processReturnItems,
};