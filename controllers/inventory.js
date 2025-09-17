const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');

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

// Validate ObjectId
const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create inventory item
const createInventory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء عنصر مخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 0, maxStockLevel = 1000, orderId } = req.body;

    // Validate input
    if (!branchId || !productId || !userId || currentStock == null) {
      console.log('إنشاء عنصر مخزون - بيانات غير صالحة:', { branchId, productId, userId, currentStock });
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة: يجب توفير معرف الفرع، معرف المنتج، معرف المستخدم، والمخزون الحالي' });
    }

    // Validate user
    const user = await User.findById(userId);
    if (!user) {
      console.log('إنشاء عنصر مخزون - المستخدم غير موجود:', { userId });
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    // Authorization check: Allow branch users to create inventory for their branch
    if (req.user.role === 'branch' && (!req.user.branchId || branchId !== req.user.branchId.toString())) {
      console.log('إنشاء عنصر مخزون - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
        role: req.user.role,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    // Validate product
    const product = await Product.findById(productId);
    if (!product) {
      console.log('إنشاء عنصر مخزون - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId);
    if (!branch) {
      console.log('إنشاء عنصر مخزون - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Validate orderId if provided
    if (orderId) {
      const order = await Order.findById(orderId);
      if (!order) {
        console.log('إنشاء عنصر مخزون - الطلبية غير موجودة:', { orderId });
        return res.status(404).json({ success: false, message: 'الطلبية غير موجودة' });
      }
      if (order.status !== 'delivered') {
        console.log('إنشاء عنصر مخزون - حالة الطلبية غير صالحة:', { orderId, status: order.status });
        return res.status(400).json({ success: false, message: 'يجب أن تكون الطلبية في حالة "تم التسليم" لتحديث المخزون' });
      }
    }

    // Create reference for inventory movement
    const reference = orderId
      ? `إنشاء مخزون بواسطة ${req.user.username} بعد تأكيد تسليم الطلبية #${orderId}`
      : `إنشاء مخزون بواسطة ${req.user.username}`;

    // Create or update inventory with atomic operation
    const existingInventory = await Inventory.findOneAndUpdate(
      { branch: branchId, product: productId },
      {
        $setOnInsert: {
          product: productId,
          branch: branchId,
          currentStock,
          minStockLevel,
          maxStockLevel,
          createdBy: userId,
          movements: [{
            type: 'in',
            quantity: currentStock,
            reference,
            createdBy: userId,
            createdAt: new Date(),
          }],
        },
      },
      { new: true, upsert: true }
    );

    if (!existingInventory.wasNew) {
      // Update existing inventory
      await Inventory.findOneAndUpdate(
        { _id: existingInventory._id },
        {
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
        }
      );
    }

    // Log to InventoryHistory
    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      type: 'restock',
      quantity: currentStock,
      reference,
      createdBy: userId,
    });
    await historyEntry.save();

    // Populate inventory item
    const populatedItem = await Inventory.findById(existingInventory._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .lean();

    // Emit WebSocket notification
    req.io?.emit('inventoryUpdated', {
      branchId: existingInventory.branch.toString(),
      productId: existingInventory.product.toString(),
      quantity: existingInventory.currentStock + (existingInventory.wasNew ? 0 : currentStock),
      type: 'in',
      reference,
    });

    console.log('إنشاء/تحديث عنصر مخزون - تم بنجاح:', {
      inventoryId: existingInventory._id,
      productId,
      branchId,
      userId,
      maxStockLevel,
      minStockLevel,
      currentStock,
      orderId,
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

    // Apply branch filter
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المخزون - معرف الفرع غير صالح للمستخدم:', {
          userId: req.user.id,
          branchId: req.user.branchId,
          role: req.user.role,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }

    // Apply product filter
    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    // Fetch inventory items
    let inventoryItems = await Inventory.find(query)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .lean();

    // Apply low stock filter
    if (lowStock === 'true') {
      inventoryItems = inventoryItems.filter(item => item.currentStock <= item.minStockLevel);
    }

    console.log('جلب المخزون - تم جلب العناصر:', {
      count: inventoryItems.length,
      userId: req.user.id,
      query,
      role: req.user.role,
    });

    res.status(200).json(inventoryItems);
  } catch (err) {
    console.error('خطأ في جلب المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;

    // Validate branchId
    if (!isValidObjectId(branchId)) {
      console.log('جلب المخزون حسب الفرع - معرف الفرع غير صالح:', { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    // Authorization check: Allow branch users to access their own branch or admins to access any branch
    if (req.user.role === 'branch' && (!req.user.branchId || branchId !== req.user.branchId.toString())) {
      console.log('جلب المخزون حسب الفرع - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
        role: req.user.role,
      });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى مخزون هذا الفرع' });
    }

    // Fetch inventory items
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
      role: req.user.role,
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تحديث المخزون - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

    // Validate input
    if (!id && (!productId || !branchId)) {
      console.log('تحديث المخزون - معرفات المنتج أو الفرع غير متوفرة:', { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان إذا لم يتم توفير معرف المخزون' });
    }

    // Validate product
    const product = await Product.findById(productId || (await Inventory.findById(id))?.product);
    if (!product) {
      console.log('تحديث المخزون - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId || (await Inventory.findById(id))?.branch);
    if (!branch) {
      console.log('تحديث المخزون - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Authorization check
    if (req.user.role === 'branch' && (!req.user.branchId || branchId !== req.user.branchId.toString())) {
      console.log('تحديث المخزون - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
        role: req.user.role,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    let inventoryItem;
    if (id) {
      // Update existing inventory
      inventoryItem = await Inventory.findById(id);
      if (!inventoryItem) {
        console.log('تحديث المخزون - العنصر غير موجود:', id);
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
      // Create new inventory item
      inventoryItem = new Inventory({
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
    }

    await inventoryItem.save();

    // Log to InventoryHistory
    const historyEntry = new InventoryHistory({
      product: inventoryItem.product,
      branch: inventoryItem.branch,
      type: id ? 'adjustment' : 'restock',
      quantity: currentStock || 0,
      reference: `تحديث المخزون بواسطة ${req.user.username}`,
      createdBy: req.user.id,
    });
    await historyEntry.save();

    // Populate inventory item
    const populatedItem = await Inventory.findById(inventoryItem._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .lean();

    // Emit WebSocket notification
    req.io?.emit('inventoryUpdated', {
      branchId: inventoryItem.branch.toString(),
      productId: inventoryItem.product.toString(),
      quantity: inventoryItem.currentStock,
      type: id ? 'adjustment' : 'restock',
    });

    console.log('تحديث المخزون - تم بنجاح:', {
      inventoryId: inventoryItem._id,
      productId: inventoryItem.product,
      branchId: inventoryItem.branch,
      currentStock: inventoryItem.currentStock,
    });

    res.status(id ? 200 : 201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    console.error('خطأ في تحديث المخزون:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create restock request
const createRestockRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء طلب إعادة التخزين - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId, requestedQuantity, notes } = req.body;

    // Validate product
    const product = await Product.findById(productId);
    if (!product) {
      console.log('إنشاء طلب إعادة التخزين - المنتج غير موجود:', { productId });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId);
    if (!branch) {
      console.log('إنشاء طلب إعادة التخزين - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Authorization check
    if (req.user.role === 'branch' && (!req.user.branchId || branchId !== req.user.branchId.toString())) {
      console.log('إنشاء طلب إعادة التخزين - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
        role: req.user.role,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إعادة تخزين لهذا الفرع' });
    }

    // Create restock request
    const restockRequest = new RestockRequest({
      product: productId,
      branch: branchId,
      requestedQuantity,
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await restockRequest.save();

    // Populate restock request
    const populatedRequest = await RestockRequest.findById(restockRequest._id)
      .populate('product', 'name price unit department')
      .populate({
        path: 'product.department',
        select: 'name code',
      })
      .populate('branch', 'name')
      .populate('createdBy', 'username')
      .lean();

    // Emit WebSocket notification
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

    res.status(201).json({ success: true, restockRequest: populatedRequest });
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

    // Apply branch filter
    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب طلبات إعادة التخزين - معرف الفرع غير صالح للمستخدم:', {
          userId: req.user.id,
          branchId: req.user.branchId,
          role: req.user.role,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }

    // Fetch restock requests
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
      role: req.user.role,
    });

    res.status(200).json({ success: true, restockRequests });
  } catch (err) {
    console.error('خطأ في جلب طلبات إعادة التخزين:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Approve restock request
const approveRestockRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('تأكيد طلب إعادة التخزين - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { requestId } = req.params;
    const { approvedQuantity, userId } = req.body;

    // Validate user
    const user = await User.findById(userId);
    if (!user) {
      console.log('تأكيد طلب إعادة التخزين - المستخدم غير موجود:', { userId });
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    // Validate restock request
    const restockRequest = await RestockRequest.findById(requestId);
    if (!restockRequest) {
      console.log('تأكيد طلب إعادة التخزين - الطلب غير موجود:', requestId);
      return res.status(404).json({ success: false, message: 'طلب إعادة التخزين غير موجود' });
    }

    // Validate product
    const product = await Product.findById(restockRequest.product);
    if (!product) {
      console.log('تأكيد طلب إعادة التخزين - المنتج غير موجود:', { productId: restockRequest.product });
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    // Validate branch
    const branch = await Branch.findById(restockRequest.branch);
    if (!branch) {
      console.log('تأكيد طلب إعادة التخزين - الفرع غير موجود:', { branchId: restockRequest.branch });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Update restock request
    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = userId;
    restockRequest.approvedAt = new Date();
    await restockRequest.save();

    // Update inventory
    const inventoryItem = await Inventory.findOneAndUpdate(
      { product: restockRequest.product, branch: restockRequest.branch },
      {
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
        $setOnInsert: {
          product: restockRequest.product,
          branch: restockRequest.branch,
          minStockLevel: 0,
          maxStockLevel: 1000,
          createdBy: userId,
        },
      },
      { upsert: true, new: true }
    );

    // Log to InventoryHistory
    const historyEntry = new InventoryHistory({
      product: restockRequest.product,
      branch: restockRequest.branch,
      type: 'restock',
      quantity: approvedQuantity,
      reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
      createdBy: userId,
    });
    await historyEntry.save();

    // Populate restock request
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

    // Emit WebSocket notification
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
      userId,
    });

    res.status(200).json({ success: true, restockRequest: populatedRequest });
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

    // Apply branch filter
    if (branchId && isValidObjectId(branchId)) {
      query.branch = branchId;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب سجل المخزون - معرف الفرع غير صالح للمستخدم:', {
          userId: req.user.id,
          branchId: req.user.branchId,
          role: req.user.role,
        });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح للمستخدم' });
      }
      query.branch = req.user.branchId;
    }

    // Apply product filter
    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }

    // Fetch inventory history
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
      role: req.user.role,
    });

    res.status(200).json({ success: true, history });
  } catch (err) {
    console.error('خطأ في جلب سجل المخزون:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Create return request
const createReturn = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء طلب إرجاع - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { orderId, items, reason, notes, branchId } = req.body;

    // Validate order
    const order = await Order.findById(orderId).populate('branch');
    if (!order) {
      console.log('إنشاء طلب إرجاع - الطلب غير موجود:', orderId);
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    // Validate order status
    if (order.status !== 'delivered') {
      console.log('إنشاء طلب إرجاع - حالة الطلب غير صالحة:', { orderId, status: order.status });
      return res.status(400).json({ success: false, message: 'يجب أن يكون الطلب مسلمًا لإنشاء طلب إرجاع' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId);
    if (!branch) {
      console.log('إنشاء طلب إرجاع - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Authorization check
    if (req.user.role === 'branch' && (!req.user.branchId || branchId !== req.user.branchId.toString())) {
      console.log('إنشاء طلب إرجاع - غير مخول:', {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
        role: req.user.role,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إرجاع لهذا الفرع' });
    }

    // Validate items and inventory
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) {
        console.log('إنشاء طلب إرجاع - المنتج غير موجود:', { productId: item.productId });
        return res.status(404).json({ success: false, message: `المنتج ${item.productId} غير موجود` });
      }

      const inventoryItem = await Inventory.findOne({ product: item.productId, branch: branchId });
      if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
        console.log('إنشاء طلب إرجاع - الكمية غير كافية في المخزون:', {
          productId: item.productId,
          currentStock: inventoryItem?.currentStock,
          requestedQuantity: item.quantity,
        });
        return res.status(400).json({ success: false, message: `الكمية غير كافية في المخزون للمنتج ${item.productId}` });
      }
    }

    // Create return request
    const returnNumber = `RET-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const returnRequest = new Return({
      returnNumber,
      order: orderId,
      branch: branchId,
      reason,
      items: items.map(item => ({
        product: item.productId,
        quantity: item.quantity,
        reason: item.reason,
      })),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await returnRequest.save();

    // Update inventory
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
        { new: true }
      );

      // Log to InventoryHistory
      const historyEntry = new InventoryHistory({
        product: item.productId,
        branch: branchId,
        type: 'return',
        quantity: -item.quantity,
        reference: `إرجاع #${returnNumber}`,
        createdBy: req.user.id,
      });
      await historyEntry.save();
    }

    // Populate return request
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

    // Emit WebSocket notification
    req.io?.emit('returnCreated', {
      returnId: returnRequest._id,
      branchId,
      orderId,
    });

    console.log('إنشاء طلب إرجاع - تم بنجاح:', {
      returnId: returnRequest._id,
      orderId,
      branchId,
      itemsCount: items.length,
    });

    res.status(201).json({ success: true, returnRequest: populatedReturn });
  } catch (err) {
    console.error('خطأ في إنشاء طلب إرجاع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Process return items
const processReturnItems = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('معالجة عناصر الإرجاع - أخطاء التحقق:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { returnId } = req.params;
    const { branchId, items } = req.body;

    // Validate return request
    const returnRequest = await Return.findById(returnId);
    if (!returnRequest) {
      console.log('معالجة عناصر الإرجاع - الإرجاع غير موجود:', returnId);
      return res.status(404).json({ success: false, message: 'طلب الإرجاع غير موجود' });
    }

    // Validate branch
    const branch = await Branch.findById(branchId);
    if (!branch) {
      console.log('معالجة عناصر الإرجاع - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Validate items
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) {
        console.log('معالجة عناصر الإرجاع - المنتج غير موجود:', { productId: item.productId });
        return res.status(404).json({ success: false, message: `المنتج ${item.productId} غير موجود` });
      }
    }

    // Process approved items
    for (const item of items) {
      if (item.status === 'approved') {
        const inventoryItem = await Inventory.findOneAndUpdate(
          { product: item.productId, branch: branchId },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `معالجة إرجاع #${returnRequest.returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
            $setOnInsert: {
              product: item.productId,
              branch: branchId,
              minStockLevel: 0,
              maxStockLevel: 1000,
              createdBy: req.user.id,
            },
          },
          { upsert: true, new: true }
        );

        // Log to InventoryHistory
        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch: branchId,
          type: 'return_processed',
          quantity: item.quantity,
          reference: `معالجة إرجاع #${returnRequest.returnNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save();

        // Emit WebSocket notification
        req.io?.emit('inventoryUpdated', {
          branchId,
          productId: item.productId,
          quantity: inventoryItem.currentStock,
          type: 'return_processed',
        });
      }
    }

    // Update return request
    returnRequest.items = returnRequest.items.map(returnItem => {
      const updatedItem = items.find(item => item.productId === returnItem.product.toString());
      if (updatedItem) {
        return {
          ...returnItem,
          status: updatedItem.status,
          reviewNotes: updatedItem.reviewNotes?.trim(),
        };
      }
      return returnItem;
    });

    returnRequest.status = items.every(item => item.status === 'rejected') ? 'rejected' :
                          items.every(item => item.status === 'approved') ? 'approved' :
                          'partially_processed';
    await returnRequest.save();

    // Populate return request
    const populatedReturn = await Return.findById(returnId)
      .populate('order', 'orderNumber')
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('createdBy', 'username')
      .lean();

    console.log('معالجة عناصر الإرجاع - تم بنجاح:', {
      returnId,
      branchId,
      itemsCount: items.length,
    });

    res.status(200).json({ success: true, returnRequest: populatedReturn });
  } catch (err) {
    console.error('خطأ في معالجة عناصر الإرجاع:', { error: err.message, stack: err.stack, requestBody: req.body });
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
  processReturnItems,
};