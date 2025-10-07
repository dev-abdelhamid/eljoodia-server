const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create a sale
router.post(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    body('branch').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
    body('paymentMethod').optional().isIn(['cash', 'card', 'credit']).withMessage('طريقة الدفع غير صالحة (يجب أن تكون cash أو card أو credit)'),
    body('paymentStatus').optional().isIn(['pending', 'completed', 'canceled']).withMessage('حالة الدفع غير صالحة'),
    body('customerPhone').optional().matches(/^\+?\d{7,15}$/).withMessage('رقم هاتف العميل غير صالح'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      const { branch, items, paymentMethod, paymentStatus, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Create sale - Validation errors:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      // Validate branch access
      if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
        console.error(`[${new Date().toISOString()}] Create sale - Unauthorized or no branch assigned:`, {
          userId: req.user.id,
          branch,
          userBranchId: req.user.branchId,
        });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
      }

      // Verify branch exists
      const branchDoc = await Branch.findById(branch).session(session);
      if (!branchDoc) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Create sale - Branch not found:`, { branch });
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      // Validate inventory and products
      for (const item of items) {
        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Create sale - Product not found:`, { productId: item.productId });
          return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
        }
        const inventory = await Inventory.findOne({ branch, product: item.productId }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Create sale - Insufficient stock:`, {
            productId: item.productId,
            currentStock: inventory?.currentStock,
            requestedQuantity: item.quantity,
          });
          return res.status(400).json({
            success: false,
            message: isRtl ? `الكمية غير كافية في المخزون للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}`,
            error: 'insufficient_stock',
          });
        }
      }

      // Generate sale number
      const saleCount = await Sale.countDocuments().session(session);
      const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;

      // Create sale
      const newSale = new Sale({
        saleNumber,
        branch,
        items: items.map((item) => ({
          product: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        totalAmount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
        status: paymentStatus || 'completed',
        paymentMethod: paymentMethod || 'cash',
        customerName: customerName?.trim(),
        customerPhone: customerPhone?.trim(),
        notes: notes?.trim(),
        createdBy: req.user.id,
      });

      await newSale.save({ session });

      // Update inventory and history
      for (const item of items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch, product: item.productId },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `Sale #${saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );

        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch,
          action: 'sale',
          quantity: -item.quantity,
          reference: `Sale #${saleNumber}`,
          referenceType: 'sale',
          referenceId: newSale._id,
          createdBy: req.user.id,
          notes: notes?.trim(),
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: branch,
          productId: item.productId,
          quantity: inventory.currentStock,
          type: 'sale',
        });
      }

      const populatedSale = await Sale.findById(newSale._id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .session(session)
        .lean();

      populatedSale.branch = populatedSale.branch
        ? {
            ...populatedSale.branch,
            displayName: isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name || 'Unknown'),
          }
        : undefined;
      populatedSale.items = populatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'Deleted Product',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'Deleted Product') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'N/A') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      }));

      req.io?.emit('saleCreated', {
        saleId: newSale._id,
        branchId: branch,
        saleNumber,
        items,
        totalAmount: newSale.totalAmount,
        createdAt: newSale.createdAt.toISOString(),
      });

      console.log(`[${new Date().toISOString()}] Create sale - Success:`, {
        saleId: newSale._id,
        branchId: branch,
        itemsCount: items.length,
      });

      await session.commitTransaction();
      res.status(201).json(populatedSale);
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Create sale error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Get all sales
router.get(
  '/',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { branch, startDate, endDate, page = 1, limit = 20, sort = '-createdAt', lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};

      if (branch && isValidObjectId(branch)) {
        query.branch = branch;
      } else if (req.user.role === 'branch') {
        if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
          console.error(`[${new Date().toISOString()}] Get sales - No branch assigned:`, {
            userId: req.user.id,
            branchId: req.user.branchId,
          });
          return res.status(400).json({ success: false, message: isRtl ? 'لا يوجد فرع مخصص' : 'No branch assigned' });
        }
        query.branch = req.user.branchId;
      }

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
      }

      const total = await Sale.countDocuments(query);
      const sales = await Sale.find(query)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean();

      const saleIds = sales.map((s) => s._id);
      const returns = await Return.find({ order: { $in: saleIds } })
        .populate('order', 'saleNumber')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn',
        })
        .lean();

      const transformedSales = sales.map((sale) => ({
        ...sale,
        saleNumber: sale.saleNumber,
        branch: sale.branch
          ? {
              ...sale.branch,
              displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
            }
          : undefined,
        items: (sale.items || []).map((item) => ({
          ...item,
          productName: item.product?.name || 'Deleted Product',
          productNameEn: item.product?.nameEn,
          displayName: isRtl ? (item.product?.name || 'Deleted Product') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          displayUnit: isRtl ? (item.product?.unit || 'N/A') : (item.product?.unitEn || item.product?.unit || 'N/A'),
          department: item.product?.department
            ? {
                ...item.product.department,
                displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
              }
            : undefined,
        })),
        createdAt: sale.createdAt.toISOString(),
        status: sale.status,
        paymentMethod: sale.paymentMethod,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        notes: sale.notes,
        createdBy: sale.createdBy?.username || 'Unknown',
        returns: (returns || [])
          .filter((ret) => ret.order?._id.toString() === sale._id.toString())
          .map((ret) => ({
            _id: ret._id,
            returnNumber: ret.returnNumber,
            status: ret.status,
            items: (ret.items || []).map((item) => ({
              product: item.product?._id || item.product,
              productName: isRtl ? (item.product?.name || 'Deleted Product') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
              productNameEn: item.product?.nameEn,
              quantity: item.quantity,
              reason: item.reason,
            })),
            reason: ret.reason,
            createdAt: ret.createdAt.toISOString(),
          })),
      }));

      res.json({ success: true, sales: transformedSales, total, returns });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Get sales error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Update a sale
router.put(
  '/:id',
  [
    auth,
    authorize('admin'),
    body('branch').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').optional().isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').optional().isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').optional().isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').optional().isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
    body('paymentMethod').optional().isIn(['cash', 'card', 'credit']).withMessage('طريقة الدفع غير صالحة (يجب أن تكون cash أو card أو credit)'),
    body('paymentStatus').optional().isIn(['pending', 'completed', 'canceled']).withMessage('حالة الدفع غير صالحة'),
    body('customerPhone').optional().matches(/^\+?\d{7,15}$/).withMessage('رقم هاتف العميل غير صالح'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { id } = req.params;
      const { branch, items, paymentMethod, paymentStatus, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      if (!isValidObjectId(id)) {
        console.error(`[${new Date().toISOString()}] Update sale - Invalid sale ID:`, { id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Update sale - Validation errors:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      const existingSale = await Sale.findById(id).session(session);
      if (!existingSale) {
        console.error(`[${new Date().toISOString()}] Update sale - Sale not found:`, { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      // Validate branch access
      const targetBranch = branch || existingSale.branch.toString();
      if (req.user.role === 'branch' && (!req.user.branchId || targetBranch !== req.user.branchId.toString())) {
        console.error(`[${new Date().toISOString()}] Update sale - Unauthorized or no branch assigned:`, {
          userId: req.user.id,
          branch: targetBranch,
          userBranchId: req.user.branchId,
        });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
      }

      // Verify branch exists if provided
      if (branch) {
        const branchDoc = await Branch.findById(branch).session(session);
        if (!branchDoc) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] Update sale - Branch not found:`, { branch });
          return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
        }
      }

      // Validate inventory if items are updated
      if (items) {
        for (const item of items) {
          const product = await Product.findById(item.productId).session(session);
          if (!product) {
            await session.abortTransaction();
            console.error(`[${new Date().toISOString()}] Update sale - Product not found:`, { productId: item.productId });
            return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
          }
          const inventory = await Inventory.findOne({ branch: targetBranch, product: item.productId }).session(session);
          const existingItem = existingSale.items.find((i) => i.product.toString() === item.productId);
          const quantityDiff = item.quantity - (existingItem?.quantity || 0);
          if (quantityDiff > 0 && (!inventory || inventory.currentStock < quantityDiff)) {
            await session.abortTransaction();
            console.error(`[${new Date().toISOString()}] Update sale - Insufficient stock:`, {
              productId: item.productId,
              currentStock: inventory?.currentStock,
              requestedQuantity: quantityDiff,
            });
            return res.status(400).json({
              success: false,
              message: isRtl ? `الكمية غير كافية في المخزون للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}`,
              error: 'insufficient_stock',
            });
          }
        }

        // Restore inventory for old items
        for (const item of existingSale.items) {
          await Inventory.findOneAndUpdate(
            { branch: existingSale.branch, product: item.product },
            {
              $inc: { currentStock: item.quantity },
              $push: {
                movements: {
                  type: 'in',
                  quantity: item.quantity,
                  reference: `Update Sale #${existingSale.saleNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, session }
          );
        }

        // Update inventory for new items
        for (const item of items) {
          const inventory = await Inventory.findOneAndUpdate(
            { branch: targetBranch, product: item.productId },
            {
              $inc: { currentStock: -item.quantity },
              $push: {
                movements: {
                  type: 'out',
                  quantity: item.quantity,
                  reference: `Update Sale #${existingSale.saleNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, session }
          );

          const historyEntry = new InventoryHistory({
            product: item.productId,
            branch: targetBranch,
            action: 'sale_updated',
            quantity: -item.quantity,
            reference: `Update Sale #${existingSale.saleNumber}`,
            referenceType: 'sale',
            referenceId: id,
            createdBy: req.user.id,
            notes: notes?.trim(),
          });
          await historyEntry.save({ session });

          req.io?.emit('inventoryUpdated', {
            branchId: targetBranch,
            productId: item.productId,
            quantity: inventory.currentStock,
            type: 'sale_updated',
          });
        }
      }

      // Update sale
      const updateData = {
        ...(branch && { branch }),
        ...(items && {
          items: items.map((item) => ({
            product: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
          totalAmount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
        }),
        ...(paymentMethod && { paymentMethod }),
        ...(paymentStatus && { status: paymentStatus }),
        ...(customerName !== undefined && { customerName: customerName?.trim() }),
        ...(customerPhone !== undefined && { customerPhone: customerPhone?.trim() }),
        ...(notes !== undefined && { notes: notes?.trim() }),
        updatedBy: req.user.id,
        updatedAt: new Date(),
      };

      const updatedSale = await Sale.findByIdAndUpdate(id, updateData, { new: true, session })
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .populate('updatedBy', 'username')
        .lean();

      updatedSale.branch = updatedSale.branch
        ? {
            ...updatedSale.branch,
            displayName: isRtl ? updatedSale.branch.name : (updatedSale.branch.nameEn || updatedSale.branch.name || 'Unknown'),
          }
        : undefined;
      updatedSale.items = updatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'Deleted Product',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'Deleted Product') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'N/A') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      }));

      req.io?.emit('saleUpdated', {
        saleId: id,
        branchId: targetBranch,
        saleNumber: updatedSale.saleNumber,
        items: items || updatedSale.items,
        totalAmount: updatedSale.totalAmount,
        updatedAt: updatedSale.updatedAt.toISOString(),
      });

      console.log(`[${new Date().toISOString()}] Update sale - Success:`, { saleId: id, branchId: targetBranch });
      await session.commitTransaction();
      res.json({ success: true, sale: updatedSale });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Update sale error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Sales analytics endpoint
router.get(
  '/analytics',
  [auth, authorize('admin')],
  async (req, res) => {
    try {
      const { branch, startDate, endDate, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};

      if (branch && isValidObjectId(branch)) {
        query.branch = branch;
      }
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
      }

      // Total sales and count
      const totalSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$totalAmount' },
            totalCount: { $sum: 1 },
          },
        },
      ]).catch(() => [{ totalSales: 0, totalCount: 0 }]);

      // Branch sales aggregation
      const branchSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$branch',
            totalSales: { $sum: '$totalAmount' },
            saleCount: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: 'branches',
            localField: '_id',
            foreignField: '_id',
            as: 'branch',
          },
        },
        { $unwind: '$branch' },
        {
          $project: {
            branchId: '$_id',
            branchName: '$branch.name',
            branchNameEn: '$branch.nameEn',
            displayName: isRtl ? '$branch.name' : { $ifNull: ['$branch.nameEn', '$branch.name'] },
            totalSales: 1,
            saleCount: 1,
          },
        },
        { $sort: { totalSales: -1 } },
        { $limit: 10 },
      ]).catch(() => []);

      // Least branch sales aggregation
      const leastBranchSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$branch',
            totalSales: { $sum: '$totalAmount' },
            saleCount: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: 'branches',
            localField: '_id',
            foreignField: '_id',
            as: 'branch',
          },
        },
        { $unwind: '$branch' },
        {
          $project: {
            branchId: '$_id',
            branchName: '$branch.name',
            branchNameEn: '$branch.nameEn',
            displayName: isRtl ? '$branch.name' : { $ifNull: ['$branch.nameEn', '$branch.name'] },
            totalSales: 1,
            saleCount: 1,
          },
        },
        { $sort: { totalSales: 1 } },
        { $limit: 10 },
      ]).catch(() => []);

      // Product sales aggregation
      const productSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
          },
        },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            productId: '$_id',
            productName: { $ifNull: ['$product.name', 'Deleted Product'] },
            productNameEn: '$product.nameEn',
            displayName: isRtl ? { $ifNull: ['$product.name', 'Deleted Product'] } : { $ifNull: ['$product.nameEn', { $ifNull: ['$product.name', 'Deleted Product'] }] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 },
      ]).catch(() => []);

      // Least product sales aggregation
      const leastProductSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
          },
        },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            productId: '$_id',
            productName: { $ifNull: ['$product.name', 'Deleted Product'] },
            productNameEn: '$product.nameEn',
            displayName: isRtl ? { $ifNull: ['$product.name', 'Deleted Product'] } : { $ifNull: ['$product.nameEn', { $ifNull: ['$product.name', 'Deleted Product'] }] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: 1 } },
        { $limit: 10 },
      ]).catch(() => []);

      // Department sales aggregation
      const departmentSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.product',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$product.department',
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
            totalQuantity: { $sum: '$items.quantity' },
          },
        },
        {
          $lookup: {
            from: 'departments',
            localField: '_id',
            foreignField: '_id',
            as: 'department',
          },
        },
        { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            departmentId: '$_id',
            departmentName: { $ifNull: ['$department.name', 'Unknown'] },
            departmentNameEn: '$department.nameEn',
            displayName: isRtl ? { $ifNull: ['$department.name', 'Unknown'] } : { $ifNull: ['$department.nameEn', { $ifNull: ['$department.name', 'Unknown'] }] },
            totalRevenue: 1,
            totalQuantity: 1,
          },
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 10 },
      ]).catch(() => []);

      // Least department sales aggregation
      const leastDepartmentSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.product',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$product.department',
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
            totalQuantity: { $sum: '$items.quantity' },
          },
        },
        {
          $lookup: {
            from: 'departments',
            localField: '_id',
            foreignField: '_id',
            as: 'department',
          },
        },
        { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            departmentId: '$_id',
            departmentName: { $ifNull: ['$department.name', 'Unknown'] },
            departmentNameEn: '$department.nameEn',
            displayName: isRtl ? { $ifNull: ['$department.name', 'Unknown'] } : { $ifNull: ['$department.nameEn', { $ifNull: ['$department.name', 'Unknown'] }] },
            totalRevenue: 1,
            totalQuantity: 1,
          },
        },
        { $sort: { totalRevenue: 1 } },
        { $limit: 10 },
      ]).catch(() => []);

      // Sales trends over time
      const dateFormat = startDate && endDate && (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) > 30 ? 'month' : 'day';
      const salesTrends = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: {
              $dateToString: {
                format: dateFormat === 'month' ? '%Y-%m' : '%Y-%m-%d',
                date: '$createdAt',
              },
            },
            totalSales: { $sum: '$totalAmount' },
            saleCount: { $sum: 1 },
          },
        },
        {
          $project: {
            period: '$_id',
            totalSales: 1,
            saleCount: 1,
            _id: 0,
          },
        },
        { $sort: { period: 1 } },
      ]).catch(() => []);

      // Top customers by total purchase amount
      const topCustomers = await Sale.aggregate([
        { $match: { ...query, $or: [{ customerName: { $ne: null, $ne: '' } }, { customerPhone: { $ne: null, $ne: '' } }] } },
        {
          $group: {
            _id: { name: '$customerName', phone: '$customerPhone' },
            totalSpent: { $sum: '$totalAmount' },
            purchaseCount: { $sum: 1 },
          },
        },
        {
          $project: {
            customerName: { $ifNull: ['$_id.name', 'Unknown'] },
            customerPhone: { $ifNull: ['$_id.phone', ''] },
            totalSpent: 1,
            purchaseCount: 1,
            _id: 0,
          },
        },
        { $sort: { totalSpent: -1 } },
        { $limit: 5 },
      ]).catch(() => []);

      const topProduct = productSales.length > 0
        ? productSales[0]
        : { productId: null, productName: isRtl ? 'غير معروف' : 'Unknown', displayName: isRtl ? 'غير معروف' : 'Unknown', totalQuantity: 0, totalRevenue: 0 };

      const response = {
        branchSales: branchSales || [],
        leastBranchSales: leastBranchSales || [],
        productSales: productSales || [],
        leastProductSales: leastProductSales || [],
        departmentSales: departmentSales || [],
        leastDepartmentSales: leastDepartmentSales || [],
        totalSales: totalSales[0]?.totalSales || 0,
        totalCount: totalSales[0]?.totalCount || 0,
        averageOrderValue: totalSales[0]?.totalCount ? (totalSales[0].totalSales / totalSales[0].totalCount).toFixed(2) : 0,
        topProduct,
        salesTrends: salesTrends || [],
        topCustomers: topCustomers || [],
      };

      res.json({ success: true, ...response });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Get sales analytics error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Get sale by ID
router.get(
  '/:id',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      if (!isValidObjectId(id)) {
        console.error(`[${new Date().toISOString()}] Get sale - Invalid sale ID:`, { id });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .lean();

      if (!sale) {
        console.error(`[${new Date().toISOString()}] Get sale - Sale not found:`, { id });
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId?.toString()) {
        console.error(`[${new Date().toISOString()}] Get sale - Unauthorized:`, { userId: req.user.id, branchId: sale.branch._id });
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى هذا البيع' : 'Unauthorized to access this sale' });
      }

      const returns = await Return.find({ order: id })
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn',
        })
        .lean();

      const transformedSale = {
        ...sale,
        saleNumber: sale.saleNumber,
        branch: sale.branch
          ? {
              ...sale.branch,
              displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
            }
          : undefined,
        items: (sale.items || []).map((item) => ({
          ...item,
          productName: item.product?.name || 'Deleted Product',
          productNameEn: item.product?.nameEn,
          displayName: isRtl ? (item.product?.name || 'Deleted Product') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          displayUnit: isRtl ? (item.product?.unit || 'N/A') : (item.product?.unitEn || item.product?.unit || 'N/A'),
          department: item.product?.department
            ? {
                ...item.product.department,
                displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
              }
            : undefined,
        })),
        createdAt: sale.createdAt.toISOString(),
        status: sale.status,
        paymentMethod: sale.paymentMethod,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        notes: sale.notes,
        createdBy: sale.createdBy?.username || 'Unknown',
        returns: (returns || []).map((ret) => ({
          _id: ret._id,
          returnNumber: ret.returnNumber,
          status: ret.status,
          items: (ret.items || []).map((item) => ({
            product: item.product?._id || item.product,
            productName: isRtl ? (item.product?.name || 'Deleted Product') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
            productNameEn: item.product?.nameEn,
            quantity: item.quantity,
            reason: item.reason,
          })),
          reason: ret.reason,
          createdAt: ret.createdAt.toISOString(),
        })),
      };

      res.json({ success: true, sale: transformedSale });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Get sale error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Delete a sale
router.delete(
  '/:id',
  [auth, authorize('admin')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      if (!isValidObjectId(id)) {
        console.error(`[${new Date().toISOString()}] Delete sale - Invalid sale ID:`, { id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        console.error(`[${new Date().toISOString()}] Delete sale - Sale not found:`, { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      // Restore inventory
      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch: sale.branch, product: item.product },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `Cancel Sale #${sale.saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: sale.branch,
          action: 'sale_cancelled',
          quantity: item.quantity,
          reference: `Cancel Sale #${sale.saleNumber}`,
          referenceType: 'sale',
          referenceId: sale._id,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: sale.branch.toString(),
          productId: item.product.toString(),
          quantity: inventory.currentStock,
          type: 'sale_cancelled',
        });
      }

      await Sale.deleteOne({ _id: id }).session(session);
      req.io?.emit('saleDeleted', { saleId: id, branchId: sale.branch.toString() });

      console.log(`[${new Date().toISOString()}] Delete sale - Success:`, { saleId: id, branchId: sale.branch });
      await session.commitTransaction();
      res.json({ success: true, message: isRtl ? 'تم حذف البيع بنجاح' : 'Sale deleted successfully' });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Delete sale error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;