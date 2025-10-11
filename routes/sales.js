const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, query } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');
const User = require('../models/User');
const { createNotification } = require('./notifications');
const crypto = require('crypto');
const { transformSaleData, getSalesAnalytics } = require('./analyticsUtils');

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
    body('paymentMethod').optional().isIn(['cash', 'card', 'credit']).withMessage('طريقة الدفع غير صالحة'),
    body('customerName').optional().isString().trim(),
    body('customerPhone').optional().isString().trim(),
    body('notes').optional().isString().trim(),
    body('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      const { branch, items, paymentMethod = 'cash', customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Create sale - Validation errors:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
        console.error(`[${new Date().toISOString()}] Create sale - Unauthorized or no branch assigned:`, {
          userId: req.user.id,
          branch,
          userBranchId: req.user.branchId,
        });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
      }

      const branchDoc = await Branch.findById(branch).session(session);
      if (!branchDoc) {
        console.error(`[${new Date().toISOString()}] Create sale - Branch not found:`, { branch });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      for (const item of items) {
        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          console.error(`[${new Date().toISOString()}] Create sale - Product not found:`, { productId: item.productId });
          await session.abortTransaction();
          return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
        }
        const inventory = await Inventory.findOne({ branch, product: item.productId }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          console.error(`[${new Date().toISOString()}] Create sale - Insufficient stock:`, {
            productId: item.productId,
            currentStock: inventory?.currentStock,
            requestedQuantity: item.quantity,
          });
          await session.abortTransaction();
          return res.status(400).json({
            success: false,
            message: isRtl ? `الكمية غير كافية للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}`,
            error: 'insufficient_stock',
          });
        }
      }

      const saleCount = await Sale.countDocuments().session(session);
      const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;
      const eventId = crypto.randomUUID();

      const newSale = new Sale({
        saleNumber,
        branch,
        items: items.map((item) => ({
          product: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        totalAmount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
        status: 'completed',
        paymentMethod,
        customerName: customerName?.trim(),
        customerPhone: customerPhone?.trim(),
        notes: notes?.trim(),
        createdBy: req.user.id,
      });

      await newSale.save({ session });

      for (const item of items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch, product: item.productId },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `بيع #${saleNumber}`,
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
          reference: `بيع #${saleNumber}`,
          referenceType: 'sale',
          referenceId: newSale._id,
          createdBy: req.user.id,
          notes: notes?.trim(),
        });
        await historyEntry.save({ session });

        if (req.io) {
          req.io.emit('inventoryUpdated', {
            branchId: branch,
            productId: item.productId,
            quantity: inventory.currentStock,
            type: 'sale',
            eventId,
          });
        }
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

      const transformedSale = transformSaleData(populatedSale, isRtl);

      if (req.io) {
        const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean();
        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const message = isRtl
          ? `تم إنشاء بيع جديد ${saleNumber} في ${transformedSale.branch.displayName}`
          : `New sale ${saleNumber} created at ${transformedSale.branch.displayName}`;

        for (const user of [...branchUsers, ...adminUsers]) {
          await createNotification(
            user._id,
            'saleCreated',
            message,
            {
              saleId: newSale._id,
              saleNumber,
              branchId: branch,
              branchName: transformedSale.branch.displayName,
              totalAmount: newSale.totalAmount,
              createdAt: newSale.createdAt.toISOString(),
              eventId,
            },
            req.io,
            true
          );
        }

        req.io.emit('saleCreated', {
          _id: newSale._id,
          saleId: newSale._id,
          saleNumber,
          branch: {
            _id: branch,
            name: transformedSale.branch.name,
            nameEn: transformedSale.branch.nameEn,
            displayName: transformedSale.branch.displayName,
          },
          items: transformedSale.items,
          totalAmount: newSale.totalAmount,
          createdAt: newSale.createdAt.toISOString(),
          eventId,
        });
      }

      console.log(`[${new Date().toISOString()}] Create sale - Success:`, {
        saleId: newSale._id,
        branchId: branch,
        itemsCount: items.length,
        eventId,
      });

      await session.commitTransaction();
      res.status(201).json({ success: true, sale: transformedSale });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Create sale - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Update sale
router.put(
  '/:id',
  [
    auth,
    authorize('branch', 'admin'),
    body('items').optional().isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').optional().isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').optional().isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').optional().isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
    body('paymentMethod').optional().isIn(['cash', 'card', 'credit']).withMessage('طريقة الدفع غير صالحة'),
    body('customerName').optional().isString().trim(),
    body('customerPhone').optional().isString().trim(),
    body('notes').optional().isString().trim(),
    body('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      const { id } = req.params;
      const { items, paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';
      const eventId = crypto.randomUUID();

      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Update sale - Validation errors:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      if (!isValidObjectId(id)) {
        console.error(`[${new Date().toISOString()}] Update sale - Invalid sale ID:`, { id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        console.error(`[${new Date().toISOString()}] Update sale - Sale not found:`, { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId.toString()) {
        console.error(`[${new Date().toISOString()}] Update sale - Unauthorized:`, { userId: req.user.id, branchId: sale.branch });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول' : 'Unauthorized access' });
      }

      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch: sale.branch, product: item.product },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `تحديث بيع #${sale.saleNumber} (استعادة)`,
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
          action: 'sale_update_restore',
          quantity: item.quantity,
          reference: `تحديث بيع #${sale.saleNumber}`,
          referenceType: 'sale',
          referenceId: sale._id,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        if (req.io) {
          req.io.emit('inventoryUpdated', {
            branchId: sale.branch.toString(),
            productId: item.product.toString(),
            quantity: inventory.currentStock,
            type: 'sale_update_restore',
            eventId,
          });
        }
      }

      if (paymentMethod) sale.paymentMethod = paymentMethod;
      if (customerName !== undefined) sale.customerName = customerName?.trim();
      if (customerPhone !== undefined) sale.customerPhone = customerPhone?.trim();
      if (notes !== undefined) sale.notes = notes?.trim();

      if (items) {
        for (const item of items) {
          const product = await Product.findById(item.productId).session(session);
          if (!product) {
            console.error(`[${new Date().toISOString()}] Update sale - Product not found:`, { productId: item.productId });
            await session.abortTransaction();
            return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
          }
          const inventory = await Inventory.findOne({ branch: sale.branch, product: item.productId }).session(session);
          if (!inventory || inventory.currentStock < item.quantity) {
            console.error(`[${new Date().toISOString()}] Update sale - Insufficient stock:`, {
              productId: item.productId,
              currentStock: inventory?.currentStock,
              requestedQuantity: item.quantity,
            });
            await session.abortTransaction();
            return res.status(400).json({
              success: false,
              message: isRtl ? `الكمية غير كافية للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}`,
            });
          }
        }

        sale.items = items.map((item) => ({
          product: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        }));
        sale.totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

        for (const item of items) {
          const inventory = await Inventory.findOneAndUpdate(
            { branch: sale.branch, product: item.productId },
            {
              $inc: { currentStock: -item.quantity },
              $push: {
                movements: {
                  type: 'out',
                  quantity: item.quantity,
                  reference: `تحديث بيع #${sale.saleNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, session }
          );

          const historyEntry = new InventoryHistory({
            product: item.productId,
            branch: sale.branch,
            action: 'sale_update_deduct',
            quantity: -item.quantity,
            reference: `تحديث بيع #${sale.saleNumber}`,
            referenceType: 'sale',
            referenceId: sale._id,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });

          if (req.io) {
            req.io.emit('inventoryUpdated', {
              branchId: sale.branch.toString(),
              productId: item.productId,
              quantity: inventory.currentStock,
              type: 'sale_update_deduct',
              eventId,
            });
          }
        }
      }

      await sale.save({ session });

      const populatedSale = await Sale.findById(id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .session(session)
        .lean();

      const transformedSale = transformSaleData(populatedSale, isRtl);

      if (req.io) {
        req.io.emit('saleUpdated', {
          saleId: id,
          branchId: sale.branch.toString(),
          eventId,
        });
      }

      console.log(`[${new Date().toISOString()}] Update sale - Success:`, { saleId: id, eventId });

      await session.commitTransaction();
      res.json({ success: true, sale: transformedSale });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Update sale - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Get all sales
router.get(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    query('branch').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    query('startDate').optional().isISO8601().toDate().withMessage('تاريخ البداية غير صالح'),
    query('endDate').optional().isISO8601().toDate().withMessage('تاريخ النهاية غير صالح'),
    query('page').optional().isInt({ min: 1 }).toInt().withMessage('رقم الصفحة غير صالح'),
    query('limit').optional().isInt({ min: 1 }).toInt().withMessage('الحد الأقصى غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
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
      const returns = await Return.find({ sale: { $in: saleIds } })
        .populate('sale', 'saleNumber')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn',
        })
        .lean();

      const transformedSales = sales.map((sale) => {
        sale.returns = returns.filter((ret) => ret.sale?._id.toString() === sale._id.toString());
        return transformSaleData(sale, isRtl);
      });

      console.log(`[${new Date().toISOString()}] Get sales - Success:`, {
        count: sales.length,
        userId: req.user.id,
        query,
      });

      res.json({ success: true, sales: transformedSales, total, returns });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Get sales - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Get sale by ID
router.get(
  '/:id',
  [
    auth,
    authorize('branch', 'admin'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
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

      const returns = await Return.find({ sale: id })
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn',
        })
        .lean();

      sale.returns = returns;
      const transformedSale = transformSaleData(sale, isRtl);

      console.log(`[${new Date().toISOString()}] Get sale - Success:`, { saleId: id });

      res.json({ success: true, sale: transformedSale });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Get sale - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Delete sale
router.delete(
  '/:id',
  [
    auth,
    authorize('branch', 'admin'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const eventId = crypto.randomUUID();

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

      if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId.toString()) {
        console.error(`[${new Date().toISOString()}] Delete sale - Unauthorized:`, { userId: req.user.id, branchId: sale.branch });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح لك بالوصول' : 'Unauthorized access' });
      }

      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch: sale.branch, product: item.product },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `إلغاء بيع #${sale.saleNumber}`,
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
          reference: `إلغاء بيع #${sale.saleNumber}`,
          referenceType: 'sale',
          referenceId: sale._id,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        if (req.io) {
          req.io.emit('inventoryUpdated', {
            branchId: sale.branch.toString(),
            productId: item.product.toString(),
            quantity: inventory.currentStock,
            type: 'sale_cancelled',
            eventId,
          });
        }
      }

      await Sale.deleteOne({ _id: id }).session(session);

      if (req.io) {
        req.io.emit('saleDeleted', { saleId: id, branchId: sale.branch.toString(), eventId });
      }

      console.log(`[${new Date().toISOString()}] Delete sale - Success:`, { saleId: id, branchId: sale.branch, eventId });
      await session.commitTransaction();
      res.json({ success: true, message: isRtl ? 'تم حذف البيع بنجاح' : 'Sale deleted successfully' });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Delete sale - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Sales analytics (for admin)
router.get(
  '/analytics',
  [
    auth,
    authorize('admin'),
    query('branch').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    query('startDate').optional().isISO8601().toDate().withMessage('تاريخ البداية غير صالح'),
    query('endDate').optional().isISO8601().toDate().withMessage('تاريخ النهاية غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
  async (req, res) => {
    try {
      await mongoose.connection; // Ensure DB connection
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

      const analytics = await getSalesAnalytics(query, isRtl, 10);

      console.log(`[${new Date().toISOString()}] Sales analytics - Success:`, {
        totalSales: analytics.totalSales,
        totalCount: analytics.totalCount,
        productSalesCount: analytics.productSales.length,
        departmentSalesCount: analytics.departmentSales.length,
      });

      res.json({ success: true, ...analytics });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Sales analytics - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Branch analytics (for branch users)
router.get(
  '/branch-analytics',
  [
    auth,
    authorize('branch'),
    query('startDate').optional().isISO8601().toDate().withMessage('تاريخ البداية غير صالح'),
    query('endDate').optional().isISO8601().toDate().withMessage('تاريخ النهاية غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
  async (req, res) => {
    try {
      await mongoose.connection; // Ensure DB connection
      const { startDate, endDate, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      if (req.user.role !== 'branch' || !req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.error(`[${new Date().toISOString()}] Branch analytics - Invalid user:`, {
          userId: req.user.id,
          role: req.user.role,
          branchId: req.user.branchId,
        });
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
      }

      const branchDoc = await Branch.findById(req.user.branchId);
      if (!branchDoc) {
        console.error(`[${new Date().toISOString()}] Branch analytics - Branch not found:`, { branchId: req.user.branchId });
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      const query = { branch: mongoose.Types.ObjectId(req.user.branchId) };
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
      }

      console.log(`[${new Date().toISOString()}] Branch analytics - Query:`, {
        branchId: req.user.branchId,
        startDate: query.createdAt?.$gte,
        endDate: query.createdAt?.$lte,
      });

      const saleCount = await Sale.countDocuments(query).catch(() => 0);
      if (saleCount === 0) {
        console.warn(`[${new Date().toISOString()}] Branch analytics - No sales found:`, { branchId: req.user.branchId });
        return res.json({
          success: true,
          totalSales: 0,
          totalCount: 0,
          averageOrderValue: '0.00',
          returnRate: '0.00',
          topProduct: {
            productId: null,
            productName: isRtl ? 'غير معروف' : 'Unknown',
            productNameEn: null,
            displayName: isRtl ? 'غير معروف' : 'Unknown',
            totalQuantity: 0,
            totalRevenue: 0,
          },
          productSales: [],
          leastProductSales: [],
          departmentSales: [],
          leastDepartmentSales: [],
          salesTrends: [],
          topCustomers: [],
          returnStats: [],
        });
      }

      const analytics = await getSalesAnalytics(query, isRtl, 5);

      console.log(`[${new Date().toISOString()}] Branch analytics - Success:`, {
        branchId: req.user.branchId,
        totalSales: analytics.totalSales,
        totalCount: analytics.totalCount,
        productSalesCount: analytics.productSales.length,
        departmentSalesCount: analytics.departmentSales.length,
      });

      res.json({ success: true, ...analytics });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Branch analytics - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

module.exports = router;