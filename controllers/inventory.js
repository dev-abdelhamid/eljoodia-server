const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const RestockRequest = mongoose.model('RestockRequest');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Helper to populate inventory item
const populateInventoryItem = (query, languageContext) => {
  return query
    .populate({
      path: 'product',
      select: 'name nameEn price unit unitEn department code',
      populate: { path: 'department', select: 'name nameEn' },
    })
    .populate('branch', 'name nameEn')
    .populate('createdBy', 'username name nameEn')
    .populate('updatedBy', 'username name nameEn')
    .lean({ virtuals: true, context: languageContext });
};

// Create or update inventory item
const createInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Create inventory - validation errors:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, productId, userId, currentStock, minStockLevel = 0, maxStockLevel = 1000, orderId } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      console.log('Create inventory - invalid data:', { branchId, productId, userId, currentStock });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid branch, product, user, or stock quantity' });
    }

    // Check user authorization
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('Create inventory - user not found:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branch.toString()) {
      console.log('Create inventory - unauthorized:', { userId: req.user.id, branchId, userBranchId: req.user.branch });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized to create inventory for this branch' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log('Create inventory - product not found:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (!branch) {
      console.log('Create inventory - branch not found:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }

    // Validate order if provided
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        console.log('Create inventory - invalid order ID:', { orderId });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'Invalid order ID' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        console.log('Create inventory - order not found:', { orderId });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'Order not found' });
      }
      if (order.status !== 'delivered') {
        console.log('Create inventory - invalid order status:', { orderId, status: order.status });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'Order must be in "delivered" status' });
      }
    }

    const reference = orderId
      ? `Order delivery confirmation #${orderId} by ${req.user.username}`
      : `Inventory creation by ${req.user.username}`;

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
    const populatedItem = await populateInventoryItem(Inventory.findById(inventory._id), req.languageContext);

    // Emit inventory update event
    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
    });

    console.log('Create inventory - success:', {
      inventoryId: inventory._id,
      productId,
      branchId,
      currentStock,
      userId,
      orderId,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error creating inventory:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
      console.log('Bulk create inventory - validation errors:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { branchId, userId, orderId, items } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      console.log('Bulk create inventory - invalid data:', { branchId, userId, items });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid branch, user, or items' });
    }

    // Validate user
    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('Bulk create inventory - user not found:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branch.toString()) {
      console.log('Bulk create inventory - unauthorized:', { userId: req.user.id, branchId, userBranchId: req.user.branch });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized to create inventory for this branch' });
    }

    // Validate branch and order
    const [branch, order] = await Promise.all([
      Branch.findById(branchId).session(session),
      orderId ? Order.findById(orderId).session(session) : Promise.resolve(null),
    ]);
    if (!branch) {
      console.log('Bulk create inventory - branch not found:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }
    if (orderId && !order) {
      console.log('Bulk create inventory - order not found:', { orderId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (orderId && order && order.status !== 'delivered') {
      console.log('Bulk create inventory - invalid order status:', { orderId, status: order.status });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Order must be in "delivered" status' });
    }

    // Validate items
    const productIds = items.map(item => item.productId).filter(id => isValidObjectId(id));
    if (productIds.length !== items.length) {
      console.log('Bulk create inventory - invalid product IDs:', { invalidIds: items.map(item => item.productId) });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid product IDs' });
    }

    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      console.log('Bulk create inventory - some products not found:', { productIds });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Some products not found' });
    }

    const reference = orderId
      ? `Order delivery confirmation #${orderId} by ${req.user.username}`
      : `Bulk inventory creation by ${req.user.username}`;

    const inventories = [];
    const historyEntries = [];

    for (const item of items) {
      const { productId, currentStock, minStockLevel = 0, maxStockLevel = 1000 } = item;
      if (currentStock < 0) {
        console.log('Bulk create inventory - invalid quantity:', { productId, currentStock });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `Invalid quantity for product ${productId}` });
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
    const populatedItems = await populateInventoryItem(
      Inventory.find({ _id: { $in: inventories.map(inv => inv._id) } }),
      req.languageContext
    );

    console.log('Bulk create inventory - success:', {
      count: inventories.length,
      branchId,
      userId,
      orderId,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: populatedItems });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error bulk creating inventory:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
      if (!req.user.branch || !isValidObjectId(req.user.branch)) {
        console.log('Get inventory - invalid branch ID:', { userId: req.user.id, branchId: req.user.branch });
        return res.status(400).json({ success: false, message: 'Invalid branch ID' });
      }
      query.branch = req.user.branch;
    }

    if (product && isValidObjectId(product)) {
      query.product = product;
    }

    const inventoryItems = await populateInventoryItem(Inventory.find(query), req.languageContext);

    const filteredItems = lowStock === 'true'
      ? inventoryItems.filter(item => item.currentStock <= item.minStockLevel)
      : inventoryItems;

    console.log('Get inventory - success:', {
      count: filteredItems.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, inventory: filteredItems });
  } catch (err) {
    console.error('Error getting inventory:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// Get inventory by branch
const getInventoryByBranch = async (req, res) => {
  try {
    const { branchId } = req.params;

    if (!isValidObjectId(branchId)) {
      console.log('Get inventory by branch - invalid branch ID:', { branchId });
      return res.status(400).json({ success: false, message: 'Invalid branch ID' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branch.toString()) {
      console.log('Get inventory by branch - unauthorized:', { userId: req.user.id, branchId, userBranchId: req.user.branch });
      return res.status(403).json({ success: false, message: 'Not authorized to access inventory for this branch' });
    }

    const inventoryItems = await populateInventoryItem(Inventory.find({ branch: branchId }), req.languageContext);

    console.log('Get inventory by branch - success:', {
      count: inventoryItems.length,
      branchId,
      userId: req.user.id,
    });

    res.status(200).json({ success: true, inventory: inventoryItems });
  } catch (err) {
    console.error('Error getting inventory by branch:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// Update inventory stock
const updateStock = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Update inventory - validation errors:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel, productId, branchId } = req.body;

    if (!id && (!isValidObjectId(productId) || !isValidObjectId(branchId))) {
      console.log('Update inventory - invalid IDs:', { productId, branchId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Product ID and branch ID are required if inventory ID is not provided' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId || (await Inventory.findById(id))?.product).session(session),
      Branch.findById(branchId || (await Inventory.findById(id))?.branch).session(session),
    ]);
    if (!product) {
      console.log('Update inventory - product not found:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (!branch) {
      console.log('Update inventory - branch not found:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branch.toString()) {
      console.log('Update inventory - unauthorized:', { userId: req.user.id, branchId, userBranchId: req.user.branch });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized to update inventory for this branch' });
    }

    let inventory;
    let isNew = false;
    if (id) {
      inventory = await Inventory.findById(id).session(session);
      if (!inventory) {
        console.log('Update inventory - item not found:', { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'Inventory item not found' });
      }
    } else {
      inventory = new Inventory({
        product: productId,
        branch: branchId,
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
        reference: `Stock update by ${req.user.username}`,
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
        reference: `Update by ${req.user.username}`,
        createdBy: req.user.id,
        notes: changes.join(', '),
      });
      await historyEntry.save({ session });
    }

    // Populate response
    const populatedItem = await populateInventoryItem(Inventory.findById(inventory._id), req.languageContext);

    // Emit inventory update event if stock changed
    if (changes.length > 0) {
      req.io?.emit('inventoryUpdated', {
        branchId: inventory.branch.toString(),
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        type: stockChanged ? 'adjustment' : 'settings_adjustment',
      });
    }

    console.log('Update inventory - success:', {
      inventoryId: inventory._id,
      productId: inventory.product,
      branchId: inventory.branch,
      currentStock: inventory.currentStock,
    });

    await session.commitTransaction();
    res.status(isNew ? 201 : 200).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error updating inventory:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
      console.log('Create restock request - validation errors:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId, requestedQuantity, notes } = req.body;

    // Validate inputs
    if (!isValidObjectId(productId) || !isValidObjectId(branchId) || requestedQuantity < 1) {
      console.log('Create restock request - invalid data:', { productId, branchId, requestedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid product, branch, or requested quantity' });
    }

    // Validate product and branch
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      console.log('Create restock request - product not found:', { productId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (!branch) {
      console.log('Create restock request - branch not found:', { branchId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branch.toString()) {
      console.log('Create restock request - unauthorized:', { userId: req.user.id, branchId, userBranchId: req.user.branch });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized to create restock request for this branch' });
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
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .lean({ virtuals: true, context: req.languageContext });

    // Emit restock request event
    req.io?.emit('restockRequested', {
      requestId: restockRequest._id,
      branchId,
      productId,
      requestedQuantity,
    });

    console.log('Create restock request - success:', {
      requestId: restockRequest._id,
      productId,
      branchId,
      requestedQuantity,
    });

    await session.commitTransaction();
    res.status(201).json({ success: true, restockRequest: populatedRequest });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error creating restock request:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
      console.log('Approve restock request - validation errors:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { requestId } = req.params;
    const { approvedQuantity, userId } = req.body;

    // Validate inputs
    if (!isValidObjectId(requestId) || !isValidObjectId(userId) || approvedQuantity < 1) {
      console.log('Approve restock request - invalid data:', { requestId, userId, approvedQuantity });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid request, user, or approved quantity' });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      console.log('Approve restock request - user not found:', { userId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const restockRequest = await RestockRequest.findById(requestId).session(session);
    if (!restockRequest) {
      console.log('Approve restock request - request not found:', { requestId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Restock request not found' });
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
            reference: `Approved restock #${restockRequest._id} by ${req.user.username}`,
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
      reference: `Approved restock #${restockRequest._id}`,
      createdBy: userId,
    });
    await historyEntry.save({ session });

    // Populate response
    const populatedRequest = await RestockRequest.findById(requestId)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .populate('approvedBy', 'username')
      .lean({ virtuals: true, context: req.languageContext });

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

    console.log('Approve restock request - success:', {
      requestId,
      productId: restockRequest.product,
      branchId: restockRequest.branch,
      approvedQuantity,
      userId,
    });

    await session.commitTransaction();
    res.status(200).json({ success: true, restockRequest: populatedRequest });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error approving restock request:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
      if (!req.user.branch || !isValidObjectId(req.user.branch)) {
        console.log('Get restock requests - invalid branch ID:', { userId: req.user.id, branchId: req.user.branch });
        return res.status(400).json({ success: false, message: 'Invalid branch ID' });
      }
      query.branch = req.user.branch;
    }

    const restockRequests = await RestockRequest.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean({ virtuals: true, context: req.languageContext });

    console.log('Get restock requests - success:', {
      count: restockRequests.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, restockRequests });
  } catch (err) {
    console.error('Error getting restock requests:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
      if (!req.user.branch || !isValidObjectId(req.user.branch)) {
        console.log('Get inventory history - invalid branch ID:', { userId: req.user.id, branchId: req.user.branch });
        return res.status(400).json({ success: false, message: 'Invalid branch ID' });
      }
      query.branch = req.user.branch;
    }

    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }

    const history = await InventoryHistory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 })
      .lean({ virtuals: true, context: req.languageContext });

    console.log('Get inventory history - success:', {
      count: history.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ success: true, history });
  } catch (err) {
    console.error('Error getting inventory history:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
};