const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const RestockRequest = require('../models/RestockRequest');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create or update inventory item
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Create inventory - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 0, maxStockLevel = 1000, orderId } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      console.log(`[${new Date().toISOString()}] Create inventory - Invalid data:`, { branchId, productId, userId, currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' });
    }

    // Check user authorization
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] Create inventory - User not found:`, { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Create inventory - Unauthorized:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log(`[${new Date().toISOString()}] Create inventory - Product not found:`, { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Create inventory - Branch not found:`, { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log(`[${new Date().toISOString()}] Create inventory - Invalid order ID:`, { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log(`[${new Date().toISOString()}] Create inventory - Order not found:`, { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      }
      if (order.status !== 'delivered') {
        console.log(`[${new Date().toISOString()}] Create inventory - Invalid order status:`, { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'يجب أن تكون الطلبية في حالة "تم التسليم"' });
      }
    }

    const reference = orderId
      ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
      : `إنشاء مخزون بواسطة ${req.user.username}`;

    // Create or update inventory
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

    // Log to InventoryHistory
    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      action: 'restock',
      quantity: currentStock,
      reference,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    // Populate response
    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    // Emit inventory update event
    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
    });

    console.log(`[${new Date().toISOString()}] Create inventory - Success:`, {
      inventoryId: inventory._id,
      productId,
      branchId,
      currentStock,
      userId,
      orderId,
    });

    await session.commitTransaction();
    return res.status(201).json({ success: true, data: populatedItem });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Create inventory error:`, { error: error.message, stack: error.stack, requestBody: req.body });
    return res.status(500).json({ success: false, message: 'خطأ في إنشاء عنصر المخزون' });
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
      console.log(`[${new Date().toISOString()}] Update stock - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

    // Validate inputs
    if (!id && (!isValidObjectId(productId) || !isValidObjectId(branchId))) {
      console.log(`[${new Date().toISOString()}] Update stock - Invalid IDs:`, { productId, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج ومعرف الفرع مطلوبان إذا لم يتم توفير معرف المخزون' });
    }

    let inventory;
    let isNew = false;

    // Fetch inventory if ID is provided
    if (id) {
      if (!isValidObjectId(id)) {
        console.log(`[${new Date().toISOString()}] Update stock - Invalid inventory ID:`, { id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
      }
      inventory = await Inventory.findById(id).session(session);
      if (!inventory) {
        console.log(`[${new Date().toISOString()}] Update stock - Inventory not found:`, { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
      }
    }

    // Validate product and branch
    const productIdToUse = productId || (inventory ? inventory.product : null);
    const branchIdToUse = branchId || (inventory ? inventory.branch : null);

    if (!productIdToUse || !branchIdToUse) {
      console.log(`[${new Date().toISOString()}] Update stock - Missing productId or branchId:`, { productId, branchId, inventoryId: id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع مفقود' });
    }

    // Validate product and branch existence
    const [product, branch] = await Promise.all([
      Product.findById(productIdToUse).session(session),
      Branch.findById(branchIdToUse).session(session),
    ]);

    if (!product) {
      console.log(`[${new Date().toISOString()}] Update stock - Product not found:`, { productId: productIdToUse });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Update stock - Branch not found:`, { branchId: branchIdToUse });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    // Check authorization
    if (req.user.role === 'branch' && branchIdToUse.toString() !== req.user.branchId?.toString()) {
      console.error(`[${new Date().toISOString()}] Update stock - Unauthorized:`, {
        userId: req.user.id,
        branchId: branchIdToUse,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    // Create new inventory if no ID provided
    if (!id) {
      inventory = new Inventory({
        product: productIdToUse,
        branch: branchIdToUse,
        currentStock: currentStock || 0,
        minStockLevel: minStockLevel || 0,
        maxStockLevel: maxStockLevel || 1000,
        createdBy: req.user.id,
        updatedBy: req.user.id,
        movements: [],
      });
      isNew = true;
    }

    const changes = [];
    let stockChanged = false;
    const oldStock = inventory.currentStock;
    const oldMin = inventory.minStockLevel;
    const oldMax = inventory.maxStockLevel;

    if (currentStock !== undefined && currentStock !== oldStock) {
      changes.push(`currentStock from ${oldStock} to ${currentStock}`);
      inventory.currentStock = currentStock;
      stockChanged = true;
      inventory.movements.push({
        type: currentStock > oldStock ? 'in' : 'out',
        quantity: Math.abs(currentStock - oldStock),
        reference: `تحديث المخزون بواسطة ${req.user.username}`,
        createdBy: req.user.id,
        createdAt: new Date(),
      });
    }

    if (minStockLevel !== undefined && minStockLevel !== oldMin) {
      changes.push(`minStockLevel from ${oldMin} to ${minStockLevel}`);
      inventory.minStockLevel = minStockLevel;
    }

    if (maxStockLevel !== undefined && maxStockLevel !== oldMax) {
      changes.push(`maxStockLevel from ${oldMax} to ${maxStockLevel}`);
      inventory.maxStockLevel = maxStockLevel;
    }

    if (minStockLevel !== undefined && maxStockLevel !== undefined && minStockLevel >= maxStockLevel) {
      console.log(`[${new Date().toISOString()}] Update stock - Invalid stock levels:`, {
        minStockLevel,
        maxStockLevel,
      });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' });
    }

    if (changes.length > 0 || isNew) {
      inventory.updatedBy = req.user.id;
      await inventory.save({ session });

      const historyAction = stockChanged ? 'adjustment' : 'settings_adjustment';
      const historyQuantity = stockChanged ? (currentStock - oldStock) : 0;

      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
        action: historyAction,
        quantity: historyQuantity,
        reference: `تحديث بواسطة ${req.user.username}`,
        createdBy: req.user.id,
        notes: changes.join(', '),
      });
      await historyEntry.save({ session });
    }

    // Populate response
    const populatedItem = await Inventory.findById(inventory._id)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    // Emit inventory update event if stock changed
    if (changes.length > 0) {
      req.io?.emit('inventoryUpdated', {
        branchId: inventory.branch.toString(),
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        type: stockChanged ? 'adjustment' : 'settings_adjustment',
      });
    }

    console.log(`[${new Date().toISOString()}] Update stock - Success:`, {
      inventoryId: inventory._id,
      productId: inventory.product,
      branchId: inventory.branch,
      currentStock: inventory.currentStock,
    });

    await session.commitTransaction();
    return res.status(isNew ? 201 : 200).json({ success: true, data: populatedItem });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Update stock error:`, { error: error.message, stack: error.stack, requestBody: req.body, params: req.params });
    return res.status(500).json({ success: false, message: 'خطأ في تحديث المخزون' });
  } finally {
    session.endSession();
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;
    const { lang = 'ar' } = req.query;

    if (!isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Invalid branch ID:`, { branchId });
      return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
    }

    // Verify branch exists
    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Branch not found:`, { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لعرض مخزون هذا الفرع' });
    }

    // Fetch inventory with populated product and department
    const inventory = await Inventory.find({ branch: branchId })
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: {
          path: 'department',
          select: 'name nameEn',
        },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    // Handle cases where product or department is missing
    const inventoryWithDefaults = inventory.map((item) => {
      if (!item.product) {
        console.warn(`[${new Date().toISOString()}] Get inventory by branch - Product missing for inventory:`, item._id);
        return {
          ...item,
          product: {
            _id: '',
            name: lang === 'ar' ? 'منتج غير معروف' : 'Unknown Product',
            nameEn: 'Unknown Product',
            code: 'N/A',
            unit: lang === 'ar' ? 'غير محدد' : 'N/A',
            unitEn: 'N/A',
            department: {
              _id: '',
              name: lang === 'ar' ? 'بدون قسم' : 'No Department',
              nameEn: 'No Department',
            },
          },
        };
      }
      if (!item.product.department) {
        console.warn(`[${new Date().toISOString()}] Get inventory by branch - Department missing for product:`, item.product._id);
        item.product.department = {
          _id: '',
          name: lang === 'ar' ? 'بدون قسم' : 'No Department',
          nameEn: 'No Department',
        };
      }
      return {
        ...item,
        product: {
          _id: item.product._id,
          name: item.product.name,
          nameEn: item.product.nameEn || item.product.name,
          code: item.product.code || 'N/A',
          unit: item.product.unit || (lang === 'ar' ? 'غير محدد' : 'N/A'),
          unitEn: item.product.unitEn || item.product.unit || 'N/A',
          department: {
            _id: item.product.department._id || '',
            name: item.product.department.name || (lang === 'ar' ? 'بدون قسم' : 'No Department'),
            nameEn: item.product.department.nameEn || item.product.department.name || 'No Department',
          },
        },
      };
    });

    console.log(`[${new Date().toISOString()}] Get inventory by branch - Success:`, {
      branchId,
      userId: req.user.id,
      count: inventoryWithDefaults.length,
    });

    return res.status(200).json({ success: true, data: inventoryWithDefaults });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get inventory by branch error:`, { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون' });
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
        console.log(`[${new Date().toISOString()}] Get inventory - Invalid branch ID:`, { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    const inventoryItems = await Inventory.find(query)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    console.log(`[${new Date().toISOString()}] Get inventory - Success:`, {
      count: filteredItems.length,
      userId: req.user.id,
      query,
    });

    return res.status(200).json({ success: true, data: filteredItems });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get inventory error:`, { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون' });
  }
};

// Create restock request
const createRestockRequest = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Create restock request - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId, requestedQuantity, notes } = req.body;

    // Validate inputs
    if (!isValidObjectId(productId) || !isValidObjectId(branchId) || requestedQuantity < 1) {
      console.log(`[${new Date().toISOString()}] Create restock request - Invalid data:`, { productId, branchId, requestedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المنتج، الفرع، أو الكمية المطلوبة غير صالحة' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log(`[${new Date().toISOString()}] Create restock request - Product not found:`, { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Create restock request - Branch not found:`, { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Create restock request - Unauthorized:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
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

    // Populate response
    const populatedRequest = await RestockRequest.findById(restockRequest._id)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // Emit restock request event
    req.io?.emit('restockRequested', {
      requestId: restockRequest._id,
      branchId,
      productId,
      requestedQuantity,
    });

    console.log(`[${new Date().toISOString()}] Create restock request - Success:`, {
      requestId: restockRequest._id,
      productId,
      branchId,
      requestedQuantity,
    });

    await session.commitTransaction();
    return res.status(201).json({ success: true, data: populatedRequest });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Create restock request error:`, { error: error.message, stack: error.stack, requestBody: req.body });
    return res.status(500).json({ success: false, message: 'خطأ في إنشاء طلب إعادة التخزين' });
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
      console.log(`[${new Date().toISOString()}] Approve restock request - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { requestId } = req.params;
    const { approvedQuantity, userId } = req.body;

    // Validate inputs
    if (!isValidObjectId(requestId) || !isValidObjectId(userId) || approvedQuantity < 1) {
      console.log(`[${new Date().toISOString()}] Approve restock request - Invalid data:`, { requestId, userId, approvedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب، المستخدم، أو الكمية المعتمدة غير صالحة' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] Approve restock request - User not found:`, { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const restockRequest = await RestockRequest.findById(requestId).session(session);
    if (!restockRequest) {
      console.log(`[${new Date().toISOString()}] Approve restock request - Request not found:`, { requestId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب إعادة التخزين غير موجود' });
    }

    // Update restock request
    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = userId;
    restockRequest.approvedAt = new Date();
    await restockRequest.save({ session });

    // Update inventory
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

    // Log to InventoryHistory
    const historyEntry = new InventoryHistory({
      product: restockRequest.product,
      branch: restockRequest.branch,
      action: 'restock',
      quantity: approvedQuantity,
      reference: `إعادة تخزين معتمدة #${restockRequest._id}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    // Populate response
    const populatedRequest = await RestockRequest.findById(requestId)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .populate('approvedBy', 'username')
      .session(session)
      .lean();

    // Emit events
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

    console.log(`[${new Date().toISOString()}] Approve restock request - Success:`, {
      requestId,
      productId: restockRequest.product,
      branchId: restockRequest.branch,
      approvedQuantity,
      userId,
    });

    await session.commitTransaction();
    return res.status(200).json({ success: true, data: populatedRequest });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Approve restock request error:`, { error: error.message, stack: error.stack, requestBody: req.body });
    return res.status(500).json({ success: false, message: 'خطأ في الموافقة على طلب إعادة التخزين' });
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
        console.log(`[${new Date().toISOString()}] Get restock requests - Invalid branch ID:`, { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    const restockRequests = await RestockRequest.find(query)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`[${new Date().toISOString()}] Get restock requests - Success:`, {
      count: restockRequests.length,
      userId: req.user.id,
      query,
    });

    return res.status(200).json({ success: true, data: restockRequests });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get restock requests error:`, { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'خطأ في جلب طلبات إعادة التخزين' });
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
        console.log(`[${new Date().toISOString()}] Get inventory history - Invalid branch ID:`, { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }

    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }

    const history = await InventoryHistory.find(query)
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`[${new Date().toISOString()}] Get inventory history - Success:`, {
      count: history.length,
      userId: req.user.id,
      query,
    });

    return res.status(200).json({ success: true, data: history });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get inventory history error:`, { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'خطأ في جلب سجل المخزون' });
  }
};

// Bulk create or update inventory items
const bulkCreate = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Validation errors:`, errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, userId, orderId, items } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid data:`, { branchId, userId, items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الفرع، المستخدم، أو العناصر غير صالحة' });
    }

    // Validate user
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - User not found:`, { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Unauthorized:`, { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    // Validate branch and order
    const [branch, order] = await Promise.all([
      Branch.findById(branchId).session(session),
      orderId ? Order.findById(orderId).session(session) : Promise.resolve(null),
    ]);
    if (!branch) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Branch not found:`, { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }
    if (orderId && !order) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Order not found:`, { orderId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }
    if (orderId && order && order.status !== 'delivered') {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid order status:`, { orderId, status: order.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'يجب أن تكون الطلبية في حالة "تم التسليم"' });
    }

    const reference = orderId
      ? `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`
      : `إنشاء دفعة مخزون بواسطة ${req.user.username}`;

    const inventories = [];
    const historyEntries = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 0, maxStockLevel = 1000 } = item;
      if (!isValidObjectId(productId) || currentStock < 0) {
        console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid item data:`, { productId, currentStock });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `بيانات العنصر غير صالحة للمنتج ${productId}` });
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

      const historyEntry = new InventoryHistory({
        product: productId,
        branch: branchId,
        action: 'restock',
        quantity: currentStock,
        reference,
        createdBy: userId,
      });
      historyEntries.push(historyEntry);

      // Emit inventory update event
      req.io?.emit('inventoryUpdated', {
        branchId,
        productId,
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
      });
    }

    await InventoryHistory.insertMany(historyEntries, { session });

    // Populate response
    const populatedItems = await Inventory.find({ _id: { $in: inventories.map(inv => inv._id) } })
      .populate('product', 'name nameEn price unit unitEn department code')
      .populate({ path: 'product.department', select: 'name nameEn' })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();

    console.log(`[${new Date().toISOString()}] Bulk create inventory - Success:`, {
      count: inventories.length,
      branchId,
      userId,
      orderId,
    });

    await session.commitTransaction();
    return res.status(201).json({ success: true, data: populatedItems });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Bulk create inventory error:`, { error: error.message, stack: error.stack, requestBody: req.body });
    return res.status(500).json({ success: false, message: 'خطأ في إنشاء دفعة المخزون' });
  } finally {
    session.endSession();
  }
};

module.exports = {
  createInventory,
  updateStock,
  getInventoryByBranch,
  getInventory,
  createRestockRequest,
  getRestockRequests,
  approveRestockRequest,
  getInventoryHistory,
  bulkCreate,
};