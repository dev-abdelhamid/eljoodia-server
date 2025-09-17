const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
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
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء عنصر مخزون - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, currentStock, minStockLevel = 0, maxStockLevel = 0, orderId } = req.body;

    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('إنشاء عنصر مخزون - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    if (currentStock < 0) {
      console.log('إنشاء عنصر مخزون - الكمية غير صالحة:', { currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكمية الحالية يجب أن تكون غير سالبة' });
    }

    const product = await Product.findById(productId).session(session);
    if (!product) {
      console.log('إنشاء عنصر مخزون - المنتج غير موجود:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('إنشاء عنصر مخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    const existingInventory = await Inventory.findOne({ branch: branchId, product: productId }).session(session);
    if (existingInventory) {
      console.log('إنشاء عنصر مخزون - عنصر المخزون موجود بالفعل:', { branchId, productId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'عنصر المخزون موجود بالفعل لهذا الفرع والمنتج' });
    }

    const reference = orderId ? `استلام الطلبية #${orderId}` : `إنشاء مخزون بواسطة ${req.user.username}`;
    const inventory = new Inventory({
      product: productId,
      branch: branchId,
      currentStock,
      minStockLevel,
      maxStockLevel,
      createdBy: req.user.id,
      movements: [{
        type: 'in',
        quantity: currentStock,
        reference,
        createdBy: req.user.id,
        createdAt: new Date(),
      }],
    });

    await inventory.save({ session });

    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      type: 'restock',
      quantity: currentStock,
      reference,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .session(session)
      .lean();

    req.app.get('io')?.emit('inventoryUpdated', {
      branchId: inventory.branch.toString(),
      productId: inventory.product.toString(),
      quantity: inventory.currentStock,
    });

    console.log('إنشاء عنصر مخزون - تم بنجاح:', {
      inventoryId: inventory._id,
      productId,
      branchId,
      currentStock,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء عنصر المخزون:', {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
      userId: req.user.id,
    });
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
    console.error('خطأ في جلب المخزون:', {
      error: err.message,
      stack: err.stack,
      userId: req.user.id,
    });
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
    console.error('خطأ في جلب المخزون حسب الفرع:', {
      error: err.message,
      stack: err.stack,
      userId: req.user.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update or create inventory stock
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

    if (id && !isValidObjectId(id)) {
      console.log('تحديث المخزون - معرف المخزون غير صالح:', id);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }
    if (!id && (!productId || !branchId || !isValidObjectId(productId) || !isValidObjectId(branchId))) {
      console.log('تحديث المخزون - معرفات المنتج أو الفرع غير صالحة:', { productId, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان ويجب أن يكونا صالحين' });
    }
    if (currentStock < 0 || (minStockLevel !== undefined && minStockLevel < 0) || (maxStockLevel !== undefined && maxStockLevel < 0)) {
      console.log('تحديث المخزون - قيم غير صالحة:', { currentStock, minStockLevel, maxStockLevel });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكميات يجب ألا تكون سالبة' });
    }

    const product = await Product.findById(productId || (await Inventory.findById(id))?.product).session(session);
    if (!product) {
      console.log('تحديث المخزون - المنتج غير موجود:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const branch = await Branch.findById(branchId || (await Inventory.findById(id))?.branch).session(session);
    if (!branch) {
      console.log('تحديث المخزون - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('تحديث المخزون - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    let inventoryItem;
    if (id) {
      inventoryItem = await Inventory.findById(id).session(session);
      if (!inventoryItem) {
        console.log('تحديث المخزون - العنصر غير موجود:', id);
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
      }
      const previousStock = inventoryItem.currentStock;
      inventoryItem.currentStock = currentStock !== undefined ? currentStock : inventoryItem.currentStock;
      inventoryItem.minStockLevel = minStockLevel !== undefined ? minStockLevel : inventoryItem.minStockLevel;
      inventoryItem.maxStockLevel = maxStockLevel !== undefined ? maxStockLevel : inventoryItem.maxStockLevel;
      inventoryItem.movements.push({
        type: currentStock > previousStock ? 'in' : 'out',
        quantity: Math.abs(currentStock - previousStock),
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
    await inventoryItem.save({ session });

    const historyEntry = new InventoryHistory({
      product: inventoryItem.product,
      branch: inventoryItem.branch,
      type: id ? 'adjustment' : 'restock',
      quantity: currentStock,
      reference: `تحديث المخزون بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    const populatedItem = await Inventory.findById(inventoryItem._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .session(session)
      .lean();

    req.app.get('io')?.emit('inventoryUpdated', {
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

    await session.commitTransaction();
    res.status(id ? 200 : 201).json(populatedItem);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تحديث المخزون:', {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
      userId: req.user.id,
    });
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
    const { productId, branchId, requestedQuantity, notes } = req.body;

    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log('إنشاء طلب إعادة التخزين - معرفات غير صالحة:', { productId, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }
    if (!requestedQuantity || requestedQuantity < 1) {
      console.log('إنشاء طلب إعادة التخزين - كمية غير صالحة:', { requestedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكمية المطلوبة يجب أن تكون أكبر من 0' });
    }

    const product = await Product.findById(productId).session(session);
    if (!product) {
      console.log('إنشاء طلب إعادة التخزين - المنتج غير موجود:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      console.log('إنشاء طلب إعادة التخزين - الفرع غير موجود:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log('إنشاء طلب إعادة التخزين - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
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
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    req.app.get('io')?.emit('restockRequested', {
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

    await session.commitTransaction();
    res.status(201).json(populatedRequest);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء طلب إعادة التخزين:', {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
      userId: req.user.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
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
    console.error('خطأ في جلب طلبات إعادة التخزين:', {
      error: err.message,
      stack: err.stack,
      userId: req.user.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Approve restock request
const approveRestockRequest = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { requestId } = req.params;
    const { approvedQuantity } = req.body;

    if (!isValidObjectId(requestId)) {
      console.log('تأكيد طلب إعادة التخزين - معرف الطلب غير صالح:', requestId);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    if (!approvedQuantity || approvedQuantity < 1) {
      console.log('تأكيد طلب إعادة التخزين - كمية غير صالحة:', { approvedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكمية المعتمدة يجب أن تكون أكبر من 0' });
    }
    if (req.user.role !== 'admin') {
      console.log('تأكيد طلب إعادة التخزين - غير مخول:', { userId: req.user.id, role: req.user.role });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد طلبات إعادة التخزين' });
    }

    const restockRequest = await RestockRequest.findById(requestId).session(session);
    if (!restockRequest) {
      console.log('تأكيد طلب إعادة التخزين - الطلب غير موجود:', requestId);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب إعادة التخزين غير موجود' });
    }

    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = req.user.id;
    restockRequest.approvedAt = new Date();
    await restockRequest.save({ session });

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
      { upsert: true, new: true, session }
    );

    const historyEntry = new InventoryHistory({
      product: restockRequest.product,
      branch: restockRequest.branch,
      type: 'restock',
      quantity: approvedQuantity,
      reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
      createdBy: req.user.id,
    });
    await historyEntry.save({ session });

    const populatedRequest = await RestockRequest.findById(requestId)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .populate('approvedBy', 'username')
      .session(session)
      .lean();

    req.app.get('io')?.emit('restockApproved', {
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

    await session.commitTransaction();
    res.status(200).json(populatedRequest);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في تأكيد طلب إعادة التخزين:', {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
      userId: req.user.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
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
    console.error('خطأ في جلب سجل المخزون:', {
      error: err.message,
      stack: err.stack,
      userId: req.user.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create return request
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { order, items, reason, notes, branch } = req.body;

    if (!isValidObjectId(order) || !isValidObjectId(branch)) {
      console.log('إنشاء طلب إرجاع - معرفات غير صالحة:', { order, branch });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو الفرع غير صالح' });
    }
    if (!reason || !items || !Array.isArray(items) || items.length === 0) {
      console.log('إنشاء طلب إرجاع - بيانات غير صالحة:', { reason, items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'سبب الإرجاع ومصفوفة العناصر مطلوبان' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !item.quantity || item.quantity < 1 || !item.reason) {
        console.log('إنشاء طلب إرجاع - عنصر غير صالح:', { product: item.product, quantity: item.quantity, reason: item.reason });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `بيانات العنصر غير صالحة: ${item.product}` });
      }
    }

    const orderDoc = await Order.findById(order).populate('branch').session(session);
    if (!orderDoc) {
      console.log('إنشاء طلب إرجاع - الطلب غير موجود:', order);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    if (orderDoc.status !== 'delivered') {
      console.log('إنشاء طلب إرجاع - حالة الطلب غير صالحة:', { order, status: orderDoc.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب مسلمًا لإنشاء طلب إرجاع' });
    }

    if (req.user.role === 'branch' && orderDoc.branch._id.toString() !== req.user.branchId.toString()) {
      console.log('إنشاء طلب إرجاع - غير مخول:', {
        userId: req.user.id,
        branchId: branch,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إرجاع لهذا الفرع' });
    }

    for (const item of items) {
      const product = await Product.findById(item.product).session(session);
      if (!product) {
        console.log('إنشاء طلب إرجاع - المنتج غير موجود:', { productId: item.product });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: `المنتج ${item.product} غير موجود` });
      }

      const inventoryItem = await Inventory.findOne({ product: item.product, branch }).session(session);
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        console.log('إنشاء طلب إرجاع - الكمية غير كافية في المخزون:', {
          productId: item.product,
          currentStock: inventoryItem?.currentStock,
          requestedQuantity: item.quantity,
        });
        await session.abortTransaction();
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

    await returnRequest.save({ session });

    await Promise.all(items.map(async (item) => {
      const inventoryUpdate = await Inventory.findOneAndUpdate(
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
        { new: true, session }
      );

      const historyEntry = new InventoryHistory({
        product: item.product,
        branch,
        type: 'return',
        quantity: -item.quantity,
        reference: `إرجاع #${returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });

      req.app.get('io')?.emit('inventoryUpdated', {
        branchId: branch,
        productId: item.product,
        quantity: inventoryUpdate.currentStock,
      });
    }));

    const populatedReturn = await Return.findById(returnRequest._id)
      .populate('order', 'orderNumber')
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    req.app.get('io')?.emit('returnCreated', {
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

    await session.commitTransaction();
    res.status(201).json(populatedReturn);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء طلب إرجاع:', {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
      userId: req.user.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
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