const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
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

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const { branch, product, lowStock } = req.query;
    const query = {};
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log(`[${new Date().toISOString()}] Invalid branch ID for user:`, {
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
    console.log(`[${new Date().toISOString()}] Fetched inventory items:`, {
      count: filteredItems.length,
      userId: req.user.id,
      query,
    });
    res.status(200).json(filteredItems);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching inventory:`, { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    if (!isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] Invalid branch ID:`, { branchId, userId: req.user.id });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      console.log(`[${new Date().toISOString()}] Unauthorized branch access:`, {
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
    console.log(`[${new Date().toISOString()}] Fetched inventory for branch:`, {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
    });
    res.status(200).json(inventoryItems);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching inventory by branch:`, { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Update or create inventory stock
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const { productId, branchId, quantity, operation, currentStock, minStockLevel, maxStockLevel } = req.body;
    if (id && !isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }
    if (!id && (!productId || !branchId || !isValidObjectId(productId) || !isValidObjectId(branchId))) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان ويجب أن يكونا صالحين' });
    }
    if (quantity !== undefined && quantity < 0 || (currentStock !== undefined && currentStock < 0) || 
        (minStockLevel !== undefined && minStockLevel < 0) || (maxStockLevel !== undefined && maxStockLevel < 0)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكميات يجب ألا تكون سالبة' });
    }
    if (operation && !['add', 'subtract'].includes(operation)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'العملية يجب أن تكون "add" أو "subtract"' });
    }
    const product = await Product.findById(productId || (await Inventory.findById(id))?.product).session(session);
    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    const branch = await Branch.findById(branchId || (await Inventory.findById(id))?.branch).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }
    let inventoryItem;
    if (id) {
      inventoryItem = await Inventory.findById(id).session(session);
      if (!inventoryItem) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
      }
      if (currentStock !== undefined) {
        inventoryItem.currentStock = currentStock;
      } else if (quantity !== undefined && operation) {
        inventoryItem.currentStock = operation === 'add' ? 
          inventoryItem.currentStock + quantity : 
          Math.max(0, inventoryItem.currentStock - quantity);
      }
      inventoryItem.minStockLevel = minStockLevel !== undefined ? minStockLevel : inventoryItem.minStockLevel;
      inventoryItem.maxStockLevel = maxStockLevel !== undefined ? maxStockLevel : inventoryItem.maxStockLevel;
    } else {
      inventoryItem = new Inventory({
        product: productId,
        branch: branchId,
        currentStock: quantity && operation === 'add' ? quantity : (currentStock || 0),
        minStockLevel: minStockLevel || 0,
        maxStockLevel: maxStockLevel || 0,
        createdBy: req.user.id,
      });
    }
    await inventoryItem.save({ session });
    const historyEntry = new InventoryHistory({
      product: inventoryItem.product,
      branch: inventoryItem.branch,
      action: operation || (id ? 'update' : 'add'),
      quantity: quantity || currentStock,
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
    req.io?.emit('inventoryUpdated', {
      branchId: inventoryItem.branch.toString(),
      productId: inventoryItem.product.toString(),
      quantity: inventoryItem.currentStock,
      eventId: `inventory_update-${inventoryItem._id}-${Date.now()}`,
    });
    await session.commitTransaction();
    console.log(`[${new Date().toISOString()}] Updated inventory successfully:`, {
      inventoryId: inventoryItem._id,
      productId: inventoryItem.product,
      branchId: inventoryItem.branch,
      currentStock: inventoryItem.currentStock,
    });
    res.status(id ? 200 : 201).json(populatedItem);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating inventory:`, { error: err.message, stack: err.stack, requestBody: req.body });
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
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }
    if (!requestedQuantity || requestedQuantity < 1) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكمية المطلوبة يجب أن تكون أكبر من 0' });
    }
    const product = await Product.findById(productId).session(session);
    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId.toString()) {
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
    req.io?.emit('restockRequested', {
      requestId: restockRequest._id,
      branchId,
      productId,
      requestedQuantity,
      eventId: `restock_request-${restockRequest._id}-${Date.now()}`,
    });
    await session.commitTransaction();
    console.log(`[${new Date().toISOString()}] Created restock request successfully:`, {
      requestId: restockRequest._id,
      productId,
      branchId,
      requestedQuantity,
    });
    res.status(201).json(populatedRequest);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating restock request:`, { error: err.message, stack: err.stack, requestBody: req.body });
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
        console.log(`[${new Date().toISOString()}] Invalid branch ID for user:`, {
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
    console.log(`[${new Date().toISOString()}] Fetched restock requests:`, {
      count: restockRequests.length,
      userId: req.user.id,
      query,
    });
    res.status(200).json(restockRequests);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching restock requests:`, { error: err.message, stack: err.stack });
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
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }
    if (!approvedQuantity || approvedQuantity < 1) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الكمية المعتمدة يجب أن تكون أكبر من 0' });
    }
    if (req.user.role !== 'admin') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتأكيد طلبات إعادة التخزين' });
    }
    const restockRequest = await RestockRequest.findById(requestId).session(session);
    if (!restockRequest) {
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
      action: 'restock',
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
    req.io?.emit('restockApproved', {
      requestId: restockRequest._id,
      branchId: restockRequest.branch.toString(),
      productId: restockRequest.product.toString(),
      quantity: approvedQuantity,
      eventId: `restock_approved-${restockRequest._id}-${Date.now()}`,
    });
    await session.commitTransaction();
    console.log(`[${new Date().toISOString()}] Approved restock request successfully:`, {
      requestId,
      productId: restockRequest.product,
      branchId: restockRequest.branch,
      approvedQuantity,
    });
    res.status(200).json(populatedRequest);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving restock request:`, { error: err.message, stack: err.stack, requestBody: req.body });
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
        console.log(`[${new Date().toISOString()}] Invalid branch ID for user:`, {
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
    console.log(`[${new Date().toISOString()}] Fetched inventory history:`, {
      count: history.length,
      userId: req.user.id,
      query,
    });
    res.status(200).json(history);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching inventory history:`, { error: err.message, stack: err.stack });
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
};