const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
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
    body('paymentMethod').optional().isIn(['cash', 'credit_card', 'bank_transfer']).withMessage('طريقة الدفع غير صالحة'),
    body('customerPhone').optional().matches(/^\+?\d{7,15}$/).withMessage('رقم هاتف العميل غير صالح'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      const { branch, items, paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] إنشاء بيع - أخطاء التحقق:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      // Validate branch access
      if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
        console.error(`[${new Date().toISOString()}] إنشاء بيع - غير مخول أو لا يوجد فرع مخصص:`, {
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
        console.error(`[${new Date().toISOString()}] إنشاء بيع - الفرع غير موجود:`, { branch });
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      // Validate inventory and products
      for (const item of items) {
        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] إنشاء بيع - المنتج غير موجود:`, { productId: item.productId });
          return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
        }
        const inventory = await Inventory.findOne({ branch, product: item.productId }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] إنشاء بيع - الكمية غير كافية:`, {
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
        status: 'completed',
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

      populatedSale.branch.displayName = isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name || 'Unknown');
      populatedSale.items = populatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
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

      console.log(`[${new Date().toISOString()}] إنشاء بيع - تم بنجاح:`, {
        saleId: newSale._id,
        branchId: branch,
        itemsCount: items.length,
      });

      await session.commitTransaction();
      res.status(201).json(populatedSale);
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في إنشاء المبيعة:`, { error: err.message, stack: err.stack });
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
          console.error(`[${new Date().toISOString()}] جلب المبيعات - لا يوجد فرع مخصص:`, {
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
          productName: item.product?.name || 'منتج محذوف',
          productNameEn: item.product?.nameEn,
          displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
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
              productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
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
      console.error(`[${new Date().toISOString()}] خطأ في جلب المبيعات:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Get sale by ID
router.get(
  '/:id',
  [auth, authorize('branch', 'admin'), param('id').isMongoId().withMessage('معرف المبيعة غير صالح')],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] جلب بيع - أخطاء التحقق:`, errors.array());
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
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
        console.error(`[${new Date().toISOString()}] جلب بيع - البيع غير موجود:`, { id });
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId?.toString()) {
        console.error(`[${new Date().toISOString()}] جلب بيع - غير مخول:`, { userId: req.user.id, branchId: sale.branch._id });
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
          productName: item.product?.name || 'منتج محذوف',
          productNameEn: item.product?.nameEn,
          displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
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
            productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
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
      console.error(`[${new Date().toISOString()}] خطأ في جلب البيع:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Update a sale
router.patch(
  '/:id',
  [
    auth,
    authorize('branch', 'admin'),
    param('id').isMongoId().withMessage('معرف المبيعة غير صالح'),
    body('paymentMethod').optional().isIn(['cash', 'credit_card', 'bank_transfer']).withMessage('طريقة الدفع غير صالحة'),
    body('customerPhone').optional().matches(/^\+?\d{7,15}$/).withMessage('رقم هاتف العميل غير صالح'),
    body('customerName').optional().trim().notEmpty().withMessage('اسم العميل لا يمكن أن يكون فارغًا'),
    body('notes').optional().trim(),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { id } = req.params;
      const { paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] تحديث بيع - أخطاء التحقق:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        console.error(`[${new Date().toISOString()}] تحديث بيع - البيع غير موجود:`, { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
        console.error(`[${new Date().toISOString()}] تحديث بيع - غير مخول:`, { userId: req.user.id, branchId: sale.branch });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث هذا البيع' : 'Unauthorized to update this sale' });
      }

      // Update sale fields
      if (paymentMethod) sale.paymentMethod = paymentMethod;
      if (customerName !== undefined) sale.customerName = customerName?.trim();
      if (customerPhone !== undefined) sale.customerPhone = customerPhone?.trim();
      if (notes !== undefined) sale.notes = notes?.trim();
      sale.updatedAt = new Date();
      sale.updatedBy = req.user.id;

      await sale.save({ session });

      // Log update in inventory history if notes are updated
      if (notes !== undefined) {
        for (const item of sale.items) {
          const historyEntry = new InventoryHistory({
            product: item.product,
            branch: sale.branch,
            action: 'sale_updated',
            quantity: 0,
            reference: `تحديث بيع #${sale.saleNumber}`,
            referenceType: 'sale',
            referenceId: sale._id,
            createdBy: req.user.id,
            notes: notes?.trim() || 'تحديث بيانات المبيعة',
          });
          await historyEntry.save({ session });
        }
      }

      const populatedSale = await Sale.findById(sale._id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .session(session)
        .lean();

      populatedSale.branch.displayName = isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name || 'Unknown');
      populatedSale.items = populatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      }));

      req.io?.emit('saleUpdated', {
        saleId: sale._id,
        branchId: sale.branch.toString(),
        saleNumber: sale.saleNumber,
        updatedFields: { paymentMethod, customerName, customerPhone, notes },
        updatedAt: sale.updatedAt.toISOString(),
      });

      console.log(`[${new Date().toISOString()}] تحديث بيع - تم بنجاح:`, {
        saleId: sale._id,
        branchId: sale.branch,
        updatedFields: { paymentMethod, customerName, customerPhone, notes },
      });

      await session.commitTransaction();
      res.json({ success: true, sale: populatedSale });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في تحديث البيع:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Delete a sale
router.delete(
  '/:id',
  [auth, authorize('admin'), param('id').isMongoId().withMessage('معرف المبيعة غير صالح')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] حذف بيع - أخطاء التحقق:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        console.error(`[${new Date().toISOString()}] حذف بيع - البيع غير موجود:`, { id });
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

        req.io?.emit('inventoryUpdated', {
          branchId: sale.branch.toString(),
          productId: item.product.toString(),
          quantity: inventory.currentStock,
          type: 'sale_cancelled',
        });
      }

      await Sale.deleteOne({ _id: id }).session(session);
      req.io?.emit('saleDeleted', { saleId: id, branchId: sale.branch.toString() });

      console.log(`[${new Date().toISOString()}] حذف بيع - تم بنجاح:`, { saleId: id, branchId: sale.branch });
      await session.commitTransaction();
      res.json({ success: true, message: isRtl ? 'تم حذف البيع بنجاح' : 'Sale deleted successfully' });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في حذف البيع:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Sales analytics endpoint
router.get(
  '/analytics',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { branch, startDate, endDate, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};

      if (branch && isValidObjectId(branch)) {
        query.branch = branch;
      } else if (req.user.role === 'branch') {
        if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
          console.error(`[${new Date().toISOString()}] جلب إحصائيات - لا يوجد فرع مخصص:`, {
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

      // Top product
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
        { $unwind: '$product' },
        {
          $project: {
            name: '$product.name',
            nameEn: '$product.nameEn',
            displayName: isRtl ? '$product.name' : { $ifNull: ['$product.nameEn', '$product.name'] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 1 },
      ]).catch(() => []);

      const topProduct = productSales.length > 0
        ? {
            name: productSales[0].displayName || (isRtl ? 'غير معروف' : 'Unknown'),
            quantity: productSales[0].totalQuantity || 0,
          }
        : { name: isRtl ? 'غير معروف' : 'Unknown', quantity: 0 };

      const response = {
        totalSales: totalSales[0]?.totalSales || 0,
        totalCount: totalSales[0]?.totalCount || 0,
        averageOrderValue: totalSales[0]?.totalCount ? (totalSales[0].totalSales / totalSales[0].totalCount).toFixed(2) : 0,
        topProduct,
      };

      console.log(`[${new Date().toISOString()}] جلب إحصائيات المبيعات - تم بنجاح:`, {
        totalSales: response.totalSales,
        totalCount: response.totalCount,
        branchId: query.branch,
      });

      res.json({ success: true, ...response });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] خطأ في جلب إحصائيات المبيعات:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

module.exports = router;