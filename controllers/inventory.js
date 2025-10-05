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
    if (orderId && !isValidObjectId(orderId)) {
      console.log(`[${new Date().toISOString()}] Create inventory - Invalid order ID:`, { orderId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلبية غير صالح' });
    }

    // Check if inventory already exists
    let inventory = await Inventory.findOne({ productId, branchId }).session(session);
    if (inventory) {
      inventory.currentStock += currentStock;
      inventory.minStockLevel = minStockLevel;
      inventory.maxStockLevel = maxStockLevel;
    } else {
      inventory = new Inventory({
        productId,
        branchId,
        currentStock,
        minStockLevel,
        maxStockLevel,
        createdBy: userId,
      });
    }

    // Save inventory
    await inventory.save({ session });

    // Log inventory change in history
    const history = new InventoryHistory({
      productId,
      branchId,
      userId,
      type: orderId ? 'addition' : 'adjustment',
      quantity: currentStock,
      description: orderId ? `Added via order ${orderId}` : 'Manual inventory adjustment',
      orderId,
    });
    await history.save({ session });

    await session.commitTransaction();
    return res.status(201).json({ success: true, data: inventory });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Create inventory error:`, error);
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
    const { currentStock, minStockLevel, maxStockLevel, branchId } = req.body;

    if (!isValidObjectId(id)) {
      console.log(`[${new Date().toISOString()}] Update stock - Invalid inventory ID:`, { id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف المخزون غير صالح' });
    }

    // Fetch inventory item
    const inventory = await Inventory.findById(id).populate('productId branchId').session(session);
    if (!inventory) {
      console.log(`[${new Date().toISOString()}] Update stock - Inventory not found:`, { id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'عنصر المخزون غير موجود' });
    }

    // Validate branchId
    const inventoryBranchId = inventory.branchId?._id?.toString();
    const userBranchId = req.user.branchId?.toString();
    if (req.user.role === 'branch' && inventoryBranchId !== userBranchId) {
      console.error(`[${new Date().toISOString()}] Update stock - Unauthorized:`, {
        userId: req.user.id,
        inventoryBranchId,
        userBranchId,
      });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لتحديث مخزون هذا الفرع' });
    }

    // Update fields if provided
    if (currentStock !== undefined) inventory.currentStock = currentStock;
    if (minStockLevel !== undefined) inventory.minStockLevel = minStockLevel;
    if (maxStockLevel !== undefined) inventory.maxStockLevel = maxStockLevel;

    // Validate stock levels
    if (inventory.minStockLevel > inventory.maxStockLevel) {
      console.log(`[${new Date().toISOString()}] Update stock - Invalid stock levels:`, {
        minStockLevel: inventory.minStockLevel,
        maxStockLevel: inventory.maxStockLevel,
      });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'الحد الأدنى يجب أن يكون أقل من الحد الأقصى' });
    }

    // Save inventory
    await inventory.save({ session });

    // Log inventory change in history
    const history = new InventoryHistory({
      productId: inventory.productId,
      branchId: inventory.branchId,
      userId: req.user.id,
      type: 'adjustment',
      quantity: currentStock !== undefined ? currentStock - inventory.currentStock : 0,
      description: 'Manual stock adjustment',
    });
    await history.save({ session });

    await session.commitTransaction();
    return res.status(200).json({ success: true, data: inventory });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Update stock error:`, error);
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

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Get inventory by branch - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لعرض مخزون هذا الفرع' });
    }

    const inventory = await Inventory.find({ branchId })
      .populate({
        path: 'productId',
        populate: {
          path: 'department',
          select: 'name nameEn',
        },
      })
      .lean();

    // Add default department if not present
    const inventoryWithDefaults = inventory.map((item) => {
      if (!item.productId) {
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
      if (!item.productId.department) {
        console.warn(`[${new Date().toISOString()}] Get inventory by branch - Department missing for product:`, item.productId._id);
        item.productId.department = {
          _id: '',
          name: lang === 'ar' ? 'بدون قسم' : 'No Department',
          nameEn: 'No Department',
        };
      }
      return {
        ...item,
        product: {
          _id: item.productId._id,
          name: item.productId.name,
          nameEn: item.productId.nameEn || item.productId.name,
          code: item.productId.code,
          unit: item.productId.unit || (lang === 'ar' ? 'غير محدد' : 'N/A'),
          unitEn: item.productId.unitEn || item.productId.unit || 'N/A',
          department: {
            _id: item.productId.department._id || '',
            name: item.productId.department.name || (lang === 'ar' ? 'بدون قسم' : 'No Department'),
            nameEn: item.productId.department.nameEn || item.productId.department.name || 'No Department',
          },
        },
      };
    });

    return res.status(200).json({ success: true, data: inventoryWithDefaults });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get inventory by branch error:`, error);
    return res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون' });
  }
};

// Get all inventory items
const getInventory = async (req, res) => {
  try {
    const inventory = await Inventory.find()
      .populate({
        path: 'productId',
        populate: {
          path: 'department',
          select: 'name nameEn',
        },
      })
      .populate('branchId')
      .lean();

    return res.status(200).json({ success: true, data: inventory });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get inventory error:`, error);
    return res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون' });
  }
};

// Create restock request
const createRestockRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`[${new Date().toISOString()}] Create restock request - Validation errors:`, errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { productId, branchId, requestedQuantity, notes } = req.body;

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Create restock request - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء طلب إعادة تعبئة لهذا الفرع' });
    }

    const restockRequest = new RestockRequest({
      productId,
      branchId,
      requestedQuantity,
      notes,
      status: 'pending',
      createdBy: req.user.id,
    });

    await restockRequest.save();
    return res.status(201).json({ success: true, data: restockRequest });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Create restock request error:`, error);
    return res.status(500).json({ success: false, message: 'خطأ في إنشاء طلب إعادة التعبئة' });
  }
};

// Get restock requests
const getRestockRequests = async (req, res) => {
  try {
    const restockRequests = await RestockRequest.find()
      .populate('productId branchId createdBy')
      .lean();
    return res.status(200).json({ success: true, data: restockRequests });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get restock requests error:`, error);
    return res.status(500).json({ success: false, message: 'خطأ في جلب طلبات إعادة التعبئة' });
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

    if (!isValidObjectId(requestId) || !isValidObjectId(userId)) {
      console.log(`[${new Date().toISOString()}] Approve restock request - Invalid IDs:`, { requestId, userId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'معرف الطلب أو المستخدم غير صالح' });
    }

    const restockRequest = await RestockRequest.findById(requestId).session(session);
    if (!restockRequest) {
      console.log(`[${new Date().toISOString()}] Approve restock request - Request not found:`, { requestId });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'طلب إعادة التعبئة غير موجود' });
    }

    restockRequest.status = 'approved';
    restockRequest.approvedQuantity = approvedQuantity;
    restockRequest.approvedBy = userId;
    restockRequest.approvedAt = new Date();

    // Update inventory
    let inventory = await Inventory.findOne({
      productId: restockRequest.productId,
      branchId: restockRequest.branchId,
    }).session(session);

    if (!inventory) {
      inventory = new Inventory({
        productId: restockRequest.productId,
        branchId: restockRequest.branchId,
        currentStock: approvedQuantity,
        minStockLevel: 0,
        maxStockLevel: 1000,
        createdBy: userId,
      });
    } else {
      inventory.currentStock += approvedQuantity;
    }

    await inventory.save({ session });
    await restockRequest.save({ session });

    // Log inventory change
    const history = new InventoryHistory({
      productId: restockRequest.productId,
      branchId: restockRequest.branchId,
      userId,
      type: 'restock',
      quantity: approvedQuantity,
      description: `Restock approved for request ${requestId}`,
    });
    await history.save({ session });

    await session.commitTransaction();
    return res.status(200).json({ success: true, data: restockRequest });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Approve restock request error:`, error);
    return res.status(500).json({ success: false, message: 'خطأ في الموافقة على طلب إعادة التعبئة' });
  } finally {
    session.endSession();
  }
};

// Get inventory history
const getInventoryHistory = async (req, res) => {
  try {
    const { productId, branchId } = req.query;

    if (!isValidObjectId(productId) || !isValidObjectId(branchId)) {
      console.log(`[${new Date().toISOString()}] Get inventory history - Invalid IDs:`, { productId, branchId });
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Get inventory history - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      return res.status(403).json({ success: false, message: 'غير مخول لعرض سجل المخزون لهذا الفرع' });
    }

    const history = await InventoryHistory.find({ productId, branchId })
      .populate('productId branchId userId')
      .lean();
    return res.status(200).json({ success: true, data: history });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Get inventory history error:`, error);
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

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log(`[${new Date().toISOString()}] Bulk create inventory - Unauthorized:`, {
        userId: req.user.id,
        branchId,
        userBranchId: req.user.branchId,
      });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مخزون لهذا الفرع' });
    }

    const inventoryItems = [];
    for (const item of items) {
      const { productId, currentStock, minStockLevel = 0, maxStockLevel = 1000 } = item;

      if (!isValidObjectId(productId) || currentStock < 0) {
        console.log(`[${new Date().toISOString()}] Bulk create inventory - Invalid item data:`, { productId, currentStock });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'بيانات العنصر غير صالحة' });
      }

      let inventory = await Inventory.findOne({ productId, branchId }).session(session);
      if (inventory) {
        inventory.currentStock += currentStock;
        inventory.minStockLevel = minStockLevel;
        inventory.maxStockLevel = maxStockLevel;
      } else {
        inventory = new Inventory({
          productId,
          branchId,
          currentStock,
          minStockLevel,
          maxStockLevel,
          createdBy: userId,
        });
      }

      await inventory.save({ session });
      inventoryItems.push(inventory);

      const history = new InventoryHistory({
        productId,
        branchId,
        userId,
        type: orderId ? 'addition' : 'adjustment',
        quantity: currentStock,
        description: orderId ? `Added via order ${orderId}` : 'Manual inventory adjustment',
        orderId,
      });
      await history.save({ session });
    }

    await session.commitTransaction();
    return res.status(201).json({ success: true, data: inventoryItems });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Bulk create inventory error:`, error);
    return res.status(500).json({ success: false, message: 'خطأ في إنشاء عناصر المخزون' });
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