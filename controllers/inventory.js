const express = require('express');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Define RestockRequest Schema
const restockRequestSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  requestedQuantity: {
    type: Number,
    required: true,
    min: 1,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  notes: {
    type: String,
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  approvedAt: {
    type: Date,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true });
const RestockRequest = mongoose.model('RestockRequest', restockRequestSchema);

// Create inventory item
const createInventory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء عنصر مخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 0, maxStockLevel = 1000 } = req.body;

    // Validate input
    if (!branchId || !productId || !userId || currentStock == null) {
      console.log('إنشاء عنصر مخزون - بيانات غير صالحة:', { branchId, productId, userId, currentStock });
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة: يجب توفير معرف الفرع، معرف المنتج، معرف المستخدم، والمخزون الحالي' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('إنشاء عنصر مخزون - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    const product = await Product.findById(productId);
    if (!product) {
      console.log('إنشاء عنصر مخزون - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const branch = await Branch.findById(branchId);
    if (!branch) {
      console.log('إنشاء عنصر مخزون - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Check for existing inventory with atomic operation
    const existingInventory = await Inventory.findOneAndUpdate(
      { branch: branchId, product: productId },
      { $setOnInsert: {
        product: productId,
        branch: branchId,
        currentStock,
        minStockLevel,
        maxStockLevel,
        createdBy: userId,
        movements: [{
          type: 'in',
          quantity: currentStock,
          reference: `إنشاء مخزون بواسطة ${req.user.username} بعد تأكيد التسليم`,
          createdBy: userId,
          createdAt: new Date(),
        }],
      }},
      { new: true, upsert: true }
    );

    if (existingInventory.wasNew) {
      const historyEntry = new InventoryHistory({
        product: productId,
        branch: branchId,
        type: 'restock',
        quantity: currentStock,
        reference: `إنشاء مخزون بواسطة ${req.user.username} بعد تأكيد التسليم`,
        createdBy: userId,
      });
      await historyEntry.save();
    } else {
      // Update existing inventory
      await Inventory.findOneAndUpdate(
        { _id: existingInventory._id },
        {
          $inc: { currentStock },
          $push: {
            movements: {
              type: 'in',
              quantity: currentStock,
              reference: `إضافة مخزون بواسطة ${req.user.username} بعد تأكيد التسليم`,
              createdBy: userId,
              createdAt: new Date(),
            },
          },
        }
      );
    }

    const populatedItem = await Inventory.findById(existingInventory._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .lean();

    req.io?.emit('inventoryUpdated', {
      branchId: existingInventory.branch.toString(),
      productId: existingInventory.product.toString(),
      quantity: existingInventory.currentStock,
    });

    console.log('إنشاء/تحديث عنصر مخزون - تم بنجاح:', {
      inventoryId: existingInventory._id,
      productId,
      branchId,
      currentStock,
    });

    res.status(201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    console.error('خطأ في إنشاء/تحديث عنصر المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المخزون - معرف الفرع غير صالح للمستخدم:', {
          userId: req.user.id,
          branchId: req.user.branchId,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }
    if (product && isValidObjectId(product)) {
      query.product = product;
    }
    const inventoryItems = await Inventory.find(query)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .lean();
    let filteredItems = inventoryItems;
    if (lowStock === 'true') {
      filteredItems = inventoryItems.filter(item => item.currentStock <= item.minStockLevel);
    }
    console.log('جلب المخزون - تم جلب العناصر:', {
      count: filteredItems.length,
      userId: req.user.id,
      query,
    });
    res.status(200).json(filteredItems);
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', branchId);
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }
    const inventoryItems = await Inventory.find({ branch: branchId })
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .lean();
    console.log('جلب المخزون حسب الفرع - تم جلب العناصر:', {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
    });
    res.status(200).json(inventoryItems);
  } catch (err) {
    console.error('خطأ في جلب المخزون حسب الفرع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update or create inventory stock
const updateStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;
    if (id && !isValidObjectId(id)) {
      console.log('تحديث المخزون - معرف المخزون غير صالح:', id);
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }
    if (!id && (!productId || !branchId || !isValidObjectId(productId) || !isValidObjectId(branchId))) {
      console.log('تحديث المخزون - معرفات المنتج أو الفرع غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان ويجب أن يكونا صالحين' });
    }
    if (currentStock < 0 || (minStockLevel !== undefined && minStockLevel < 0) || (maxStockLevel !== undefined && maxStockLevel < 0)) {
      console.log('تحديث المخزون - قيم غير صالحة:', { currentStock, minStockLevel, maxStockLevel });
      return res.status(400).json({ success: false, message: 'الكميات يجب ألا تكون سالبة' });
    }
    const product = await Product.findById(productId || (await Inventory.findById(id))?.product);
    if (!product) {
      console.log('تحديث المخزون - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    const branch = await Branch.findById(branchId || (await Inventory.findById(id))?.branch);
    if (!branch) {
      console.log('تحديث المخزون - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('تحديث المخزون - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }
    let inventoryItem;
    if (id) {
      inventoryItem = await Inventory.findById(id);
      if (!inventoryItem) {
        console.log('تحديث المخزون - العنصر غير موجود:', id);
        return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
      }
      inventoryItem.currentStock = currentStock !== undefined ? currentStock : inventoryItem.currentStock;
      inventoryItem.minStockLevel = minStockLevel !== undefined ? minStockLevel : inventoryItem.minStockLevel;
      inventoryItem.maxStockLevel = maxStockLevel !== undefined ? maxStockLevel : inventoryItem.maxStockLevel;
      inventoryItem.movements.push({
        type: currentStock > inventoryItem.currentStock ? 'in' : 'out',
        quantity: Math.abs(currentStock - inventoryItem.currentStock),
        reference: `تحديث المخزون بواسطة ${req.user.username}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
    } else {
      inventoryItem = new Inventory({
        product: productId,
        branch: branchId,
        currentStock: currentStock || 0,
        minStockLevel: minStockLevel || 0,
        maxStockLevel: maxStockLevel || 0,
        createdBy: req.user.id,
        movements: [{
          type: 'in',
          quantity: currentStock || 0,
          reference: `إنشاء مخزون بواسطة ${req.user.username}`,
          createdBy: req.user.id,
          createdAt: new Date(),
        }],
      });
    }
    await inventoryItem.save();
    const historyEntry = new InventoryHistory({
      product: inventoryItem.product,
      branch: inventoryItem.branch,
      type: id ? 'adjustment' : 'restock',
      quantity: currentStock,
      reference: `تحديث المخزون بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    });
    await historyEntry.save();
    const populatedItem = await Inventory.findById(inventoryItem._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .lean();
    req.io?.emit('inventoryUpdated', {
      branchId: inventoryItem.branch.toString(),
      productId: inventoryItem.product.toString(),
      quantity: inventoryItem.currentStock,
    });
    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: inventoryItem._id,
      productId: inventoryItem.product,
      branchId: inventoryItem.branch,
      currentStock: inventoryItem.currentStock,
    });
    res.status(id ? 200 : 201).json(populatedItem);
  } catch (err) {
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create restock request
const createRestockRequest = async (req, res) => {
  try {
    const { productId, branchId, requestedQuantity, notes } = req.body;
    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log('إنشاء طلب إعادة التخزين - معرفات غير صالحة:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }
    if (!requestedQuantity || requestedQuantity < 1) {
      console.log('إنشاء طلب إعادة التخزين - كمية غير صالحة:', { requestedQuantity });
      return res.status(400).json({ success: false, message: 'الكمية المطلوبة يجب أن تكون أكبر من 0' });
    }
    const product = await Product.findById(productId);
    if (!product) {
      console.log('إنشاء طلب إعادة التخزين - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    const branch = await Branch.findById(branchId);
    if (!branch) {
      console.log('إنشاء طلب إعادة التخزين - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('إنشاء طلب إعادة التخزين - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إعادة تخزين لهذا الفرع' });
    }
    const restockRequest = new RestockRequest({
      product: productId,
      branch: branchId,
      requestedQuantity,
      notes: notes?.trim(),
      createdBy: req.user.id,
    });
    await restockRequest.save();
    const populatedRequest = await RestockRequest.findById(restockRequest._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .lean();
    req.io?.emit('restockRequested', {
      requestId: restockRequest._id,
      branchId,
      productId,
      requestedQuantity,
    });
    console.log('إنشاء طلب إعادة التخزين - تم بنجاح:', {
      requestId: restockRequest._id,
      productId,
      branchId,
      requestedQuantity,
    });
    res.status(201).json(populatedRequest);
  } catch (err) {
    console.error('خطأ في إنشاء طلب إعادة التخزين:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get restock requests
const getRestockRequests = async (req, res) => {
  try {
    const { branchId } = req.query;
    const query = {};
    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب طلبات إعادة التخزين - معرف الفرع غير صالح للمستخدم:', {
          userId: req.user.id,
          branchId: req.user.branchId,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }
    const restockRequests = await RestockRequest.find(query)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();
    console.log('جلب طلبات إعادة التخزين - تم جلب الطلبات:', {
      count: restockRequests.length,
      userId: req.user.id,
      query,
    });
    res.status(200).json(restockRequests);
  } catch (err) {
    console.error('خطأ في جلب طلبات إعادة التخزين:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Approve restock request
const approveRestockRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { approvedQuantity } = req.body;
    if (!isValidObjectId(requestId)) {
      console.log('تأكيد طلب إعادة التخزين - معرف الطلب غير صالح:', requestId);
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    if (!approvedQuantity || approvedQuantity < 1) {
      console.log('تأكيد طلب إعادة التخزين - كمية غير صالحة:', { approvedQuantity });
      return res.status(400).json({ success: false, message: 'الكمية المعتمدة يجب أن تكون أكبر من 0' });
    }
    if (req.user.role !== 'admin') {
      console.log('تأكيد طلب إعادة التخزين - غير مخول:', { userId: req.user.id, role: req.user.role });
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد طلبات إعادة التخزين' });
    }
    const restockRequest = await RestockRequest.findById(requestId);
    if (!restockRequest) {
      console.log('تأكيد طلب إعادة التخزين - الطلب غير موجود:', requestId);
      return res.status(404).json({ success: false, message: 'طلب إعادة التخزين غير موجود' });
    }
    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = req.user.id;
    restockRequest.approvedAt = new Date();
    await restockRequest.save();
    const inventoryItem = await Inventory.findOneAndUpdate(
      { product: restockRequest.product, branch: restockRequest.branch },
      {
        $inc: { currentStock: approvedQuantity },
        $push: {
          movements: {
            type: 'in',
            quantity: approvedQuantity,
            reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
            createdBy: req.user.id,
            createdAt: new Date(),
          },
        },
      },
      { upsert: true, new: true }
    );
    const historyEntry = new InventoryHistory({
      product: restockRequest.product,
      branch: restockRequest.branch,
      type: 'restock',
      quantity: approvedQuantity,
      reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
      createdBy: req.user.id,
    });
    await historyEntry.save();
    const populatedRequest = await RestockRequest.findById(requestId)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('approvedBy', 'username')
      .lean();
    req.io?.emit('restockApproved', {
      requestId: restockRequest._id,
      branchId: restockRequest.branch.toString(),
      productId: restockRequest.product.toString(),
      quantity: approvedQuantity,
    });
    console.log('تأكيد طلب إعادة التخزين - تم بنجاح:', {
      requestId,
      productId: restockRequest.product,
      branchId: restockRequest.branch,
      approvedQuantity,
    });
    res.status(200).json(populatedRequest);
  } catch (err) {
    console.error('خطأ في تأكيد طلب إعادة التخزين:', { error: err.message, stack: err.stack, requestBody: req.body });
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
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب سجل المخزون - معرف الفرع غير صالح للمستخدم:', {
          userId: req.user.id,
          branchId: req.user.branchId,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }
    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }
    const history = await InventoryHistory.find(query)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();
    console.log('جلب سجل المخزون - تم جلب السجل:', {
      count: history.length,
      userId: req.user.id,
      query,
    });
    res.status(200).json(history);
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create return request
const createReturn = async (req, res) => {
  try {
    const { order, items, reason, notes, branch } = req.body;

    if (!isValidObjectId(order) || !isValidObjectId(branch)) {
      console.log('إنشاء طلب إرجاع - معرفات غير صالحة:', { order, branch });
      return res.status(400).json({ success: false, message: 'معرف الطلب أو الفرع غير صالح' });
    }

    if (!reason || !items || !Array.isArray(items) || items.length === 0) {
      console.log('إنشاء طلب إرجاع - بيانات غير صالحة:', { reason, items });
      return res.status(400).json({ success: false, message: 'سبب الإرجاع ومصفوفة العناصر مطلوبان' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || item.quantity < 1 || !item.reason) {
        console.log('إنشاء طلب إرجاع - عنصر غير صالح:', { product: item.product, quantity: item.quantity, reason: item.reason });
        return res.status(400).json({ success: false, message: `بيانات العنصر غير صالحة: ${item.product}` });
      }
    }

    const orderDoc = await Order.findById(order).populate('branch');
    if (!orderDoc) {
      console.log('إنشاء طلب إرجاع - الطلب غير موجود:', order);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (orderDoc.status !== 'delivered') {
      console.log('إنشاء طلب إرجاع - حالة الطلب غير صالحة:', { order, status: orderDoc.status });
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب مسلمًا لإنشاء طلب إرجاع' });
    }

    if (req.user.role === 'branch' && orderDoc.branch._id.toString() !== req.user.branchId.toString()) {
      console.log('إنشاء طلب إرجاع - غير مخول:', {
        userId: req.user.id,
        branchId: branch,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إرجاع لهذا الفرع' });
    }

    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) {
        console.log('إنشاء طلب إرجاع - المنتج غير موجود:', { productId: item.product });
        return res.status(404).json({ success: false, message: `المنتج ${item.product} غير موجود` });
      }

      const inventoryItem = await Inventory.findOne({ product: item.product, branch });
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        console.log('إنشاء طلب إرجاع - الكمية غير كافية في المخزون:', {
          productId: item.product,
          currentStock: inventoryItem?.currentStock,
          requestedQuantity: item.quantity,
        });
        return res.status(400).json({ success: false, message: `الكمية غير كافية في المخزون للمنتج ${item.product}` });
      }
    }

    const returnNumber = `RET-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const returnRequest = new Return({
      returnNumber,
      order,
      branch,
      reason,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
      })),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await returnRequest.save();

    for (const item of items) {
      await Inventory.findOneAndUpdate(
        { product: item.product, branch },
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
        { new: true }
      );

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch,
        type: 'return',
        quantity: -item.quantity,
        reference: `إرجاع #${returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save();
    }

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('order', 'orderNumber')
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .lean();

    req.io?.emit('returnCreated', {
      returnId: returnRequest._id,
      branchId: branch,
      orderId: order,
    });

    console.log('إنشاء طلب إرجاع - تم بنجاح:', {
      returnId: returnRequest._id,
      orderId: order,
      branchId: branch,
      itemsCount: items.length,
    });

    res.status(201).json(populatedReturn);
  } catch (err) {
    console.error('خطأ في إنشاء طلب إرجاع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  getInventory,
  getInventoryByBranch,
  updateStock,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  createReturn,
  createInventory,
};