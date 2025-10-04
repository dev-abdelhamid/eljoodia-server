const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');
const InventoryHistory = require('../models/InventoryHistory');
const { isValidObjectId } = mongoose;

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
      return res.status(400).json({ success: false, message: 'معرف الطلب، الفرع، السبب، أو العناصر غير صالحة' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.quantity < 1 || !item.reason)) {
      console.log('إنشاء مرتجع - عناصر غير صالحة:', { items });
      return res.status(400).json({ success: false, message: 'معرفات المنتجات، الكميات، أو الأسباب غير صالحة' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('إنشاء مرتجع - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مرتجع لهذا الفرع' });
    }

    const [branch, products] = await Promise.all([
      Branch.findById(branchId).session(session).lean(),
      Product.find({ _id: { $in: items.map(item => item.productId) } }).session(session).lean(),
    ]);

    if (!branch) {
      console.log('إنشاء مرتجع - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }
    if (products.length !== items.length) {
      console.log('إنشاء مرتجع - بعض المنتجات غير موجودة:', { productIds: items.map(item => item.productId) });
      return res.status(404).json({ success: false, message: 'بعض المنتجات غير موجودة' });
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
      status: 'pending',
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

// Approve or reject a return request
const approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { returnId } = req.params;
    const { status, items, reviewNotes } = req.body;
    const lang = req.query.lang || 'ar';
    const isRtl = lang === 'ar';

    if (!isValidObjectId(returnId) || !['approved', 'rejected'].includes(status) || !Array.isArray(items) || items.length === 0) {
      console.log('الموافقة على المرتجع - بيانات غير صالحة:', { returnId, status, itemsCount: items?.length });
      return res.status(400).json({ success: false, message: 'معرف المرتجع، الحالة، أو العناصر غير صالحة' });
    }

    if (items.some(item => !isValidObjectId(item.productId) || item.quantity < 1 || !['approved', 'rejected'].includes(item.status))) {
      console.log('الموافقة على المرتجع - عناصر غير صالحة:', { items });
      return res.status(400).json({ success: false, message: 'معرفات المنتجات، الكميات، أو الحالات غير صالحة' });
    }

    const returnRequest = await Return.findById(returnId).session(session);
    if (!returnRequest) {
      console.log('الموافقة على المرتجع - المرتجع غير موجود:', { returnId });
      return res.status(404).json({ success: false, message: 'المرتجع غير موجود' });
    }

    if (req.user.role === 'branch' && returnRequest.branch.toString() !== req.user.branchId?.toString()) {
      console.log('الموافقة على المرتجع - غير مخول:', { userId: req.user.id, branchId: returnRequest.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول لمعالجة مرتجع هذا الفرع' });
    }

    if (returnRequest.status !== 'pending') {
      console.log('الموافقة على المرتجع - الحالة غير صالحة:', { returnId, currentStatus: returnRequest.status });
      return res.status(400).json({ success: false, message: 'لا يمكن معالجة مرتجع ليس بحالة قيد الانتظار' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      console.log('الموافقة على المرتجع - بعض المنتجات غير موجودة:', { productIds });
      return res.status(404).json({ success: false, message: 'بعض المنتجات غير موجودة' });
    }

    returnRequest.status = status;
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewNotes = reviewNotes;
    returnRequest.reviewedAt = new Date();

    for (const item of items) {
      const returnItem = returnRequest.items.find(i => i.product.toString() === item.productId);
      if (!returnItem || returnItem.quantity !== item.quantity) {
        console.log('الموافقة على المرتجع - عنصر غير متطابق:', { productId: item.productId, requestedQuantity: item.quantity });
        return res.status(400).json({ success: false, message: 'عنصر المرتجع غير متطابق' });
      }
      returnItem.status = item.status;
      returnItem.reviewNotes = item.reviewNotes;

      if (item.status === 'approved') {
        const inventory = await Inventory.findOne({ product: item.productId, branch: returnRequest.branch }).session(session);
        if (!inventory) {
          console.log('الموافقة على المرتجع - المخزون غير موجود:', { productId: item.productId, branchId: returnRequest.branch });
          return res.status(404).json({ success: false, message: 'المخزون غير موجود لهذا المنتج' });
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
      } else {
        const inventory = await Inventory.findOne({ product: item.productId, branch: returnRequest.branch }).session(session);
        if (inventory) {
          inventory.currentStock += item.quantity;
          await inventory.save({ session });

          const historyEntry = new InventoryHistory({
            product: item.productId,
            branch: returnRequest.branch,
            type: 'adjustment',
            quantity: item.quantity,
            reference: `رفض مرتجع ${returnRequest.returnNumber} بواسطة ${req.user.username}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });

          req.io?.emit('inventoryUpdated', {
            branchId: returnRequest.branch.toString(),
            productId: item.productId,
            quantity: inventory.currentStock,
            type: 'adjustment',
            reference: `رفض مرتجع ${returnRequest.returnNumber}`,
          });
        }
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
        return res.status(400).json({ success: false, message: 'معرف الفرع غير صالح' });
      }
      query.branch = req.user.branchId;
    }
    if (productId && isValidObjectId(productId)) {
      query.product = productId;
    }

    if (req.user.role === 'branch' && branchId && branchId !== req.user.branchId?.toString()) {
      console.log('جلب سجل المخزون - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى سجل مخزون هذا الفرع' });
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
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
      return res.status(400).json({ success: false, message: 'معرف المنتج أو الفرع غير صالح' });
    }

    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      console.log('جلب تفاصيل المنتج - غير مخول:', { userId: req.user.id, branchId, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى تفاصيل هذا الفرع' });
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
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }
    if (!branch) {
      console.log('جلب تفاصيل المنتج - الفرع غير موجود:', { branchId });
      return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
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
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
};

module.exports = {
  createReturn,
  getReturns,
  approveReturn,
  getInventoryHistory,
  getProductDetails,
};