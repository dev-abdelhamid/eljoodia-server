const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, query, validationResult } = require('express-validator');
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
    authorize('branch'),
    body('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error('إنشاء بيع - أخطاء التحقق:', errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { branchId, items, notes, paymentMethod, customerName, customerPhone, status = 'completed', lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      // Validate branch for branch users
      if (req.user.role === 'branch' && (!req.user.branchId || branchId !== req.user.branchId.toString())) {
        console.error('إنشاء بيع - غير مخول أو لا يوجد فرع مخصص:', {
          userId: req.user.id,
          branchId,
          userBranchId: req.user.branchId,
        });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
      }

      // Verify branch exists
      const branchDoc = await Branch.findById(branchId).session(session);
      if (!branchDoc) {
        await session.abortTransaction();
        console.error('إنشاء بيع - الفرع غير موجود:', { branchId });
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      // Validate inventory for each item
      for (const item of items) {
        const product = await Product.findById(item.product).session(session);
        if (!product) {
          await session.abortTransaction();
          console.error('إنشاء بيع - المنتج غير موجود:', { productId: item.product });
          return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.product} غير موجود` : `Product ${item.product} not found` });
        }
        const inventoryItem = await Inventory.findOne({ branch: branchId, product: item.product }).session(session);
        if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
          await session.abortTransaction();
          console.error('إنشاء بيع - الكمية غير كافية:', {
            productId: item.product,
            currentStock: inventoryItem?.currentStock,
            requestedQuantity: item.quantity,
          });
          return res.status(400).json({
            success: false,
            message: isRtl ? `الكمية غير كافية في المخزون للمنتج ${item.product}` : `Insufficient stock for product ${item.product}`,
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
        branch: branchId,
        items: items.map((item) => ({
          product: item.product,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        totalAmount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
        status,
        paymentMethod: paymentMethod || 'cash',
        customerName: customerName?.trim(),
        customerPhone: customerPhone?.trim(),
        notes: notes?.trim(),
        createdBy: req.user.id,
      });

      await newSale.save({ session });

      // Update inventory and create history entries for completed sales
      if (status === 'completed') {
        for (const item of items) {
          const inventory = await Inventory.findOneAndUpdate(
            { branch: branchId, product: item.product },
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
            product: item.product,
            branch: branchId,
            action: 'sale',
            quantity: -item.quantity,
            reference: `بيع #${saleNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });

          req.io?.emit('inventoryUpdated', {
            branchId,
            productId: item.product,
            quantity: inventory.currentStock,
            type: 'sale',
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

      // Transform names based on language
      populatedSale.branch.displayName = isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name);
      populatedSale.items = populatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
            }
          : undefined,
      }));

      req.io?.emit('saleCreated', {
        saleId: newSale._id,
        branchId,
        saleNumber,
        items,
        totalAmount: newSale.totalAmount,
        createdAt: newSale.createdAt,
      });

      console.log('إنشاء بيع - تم بنجاح:', {
        saleId: newSale._id,
        branchId,
        itemsCount: items.length,
      });

      await session.commitTransaction();
      res.status(201).json(populatedSale);
    } catch (err) {
      await session.abortTransaction();
      console.error('خطأ في إنشاء المبيعة:', { error: err.message, stack: err.stack });
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
      const { branch, startDate, endDate, page = 1, limit = 10, sort = '-createdAt', status, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};

      if (branch && isValidObjectId(branch)) {
        query.branch = branch;
      } else if (req.user.role === 'branch') {
        if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
          console.error('جلب المبيعات - لا يوجد فرع مخصص:', {
            userId: req.user.id,
            branchId: req.user.branchId,
          });
          return res.status(400).json({ success: false, message: isRtl ? 'لا يوجد فرع مخصص' : 'No branch assigned' });
        }
        query.branch = req.user.branchId;
      }

      if (status) query.status = status;
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
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
        orderNumber: sale.saleNumber,
        branch: {
          ...sale.branch,
          displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
        },
        items: sale.items.map((item) => ({
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
        createdAt: new Date(sale.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        returns: returns
          .filter((ret) => ret.order?._id.toString() === sale._id.toString())
          .map((ret) => ({
            _id: ret._id,
            returnNumber: ret.returnNumber,
            status: ret.status,
            items: ret.items.map((item) => ({
              product: item.product?._id || item.product,
              productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
              productNameEn: item.product?.nameEn,
              quantity: item.quantity,
              reason: item.reason,
            })),
            reason: ret.reason,
            createdAt: new Date(ret.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            }),
          })),
      }));

      console.log('جلب المبيعات - تم بنجاح:', {
        count: sales.length,
        userId: req.user.id,
        query,
      });

      res.json({ sales: transformedSales, total });
    } catch (err) {
      console.error('خطأ في جلب المبيعات:', { error: err.message, stack: err.stack });
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
        console.error('جلب بيع - معرف غير صالح:', { id });
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
        console.error('جلب بيع - البيع غير موجود:', { id });
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId?.toString()) {
        console.error('جلب بيع - غير مخول:', { userId: req.user.id, branchId: sale.branch._id });
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
        orderNumber: sale.saleNumber,
        branch: {
          ...sale.branch,
          displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
        },
        items: sale.items.map((item) => ({
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
        createdAt: new Date(sale.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        returns: returns.map((ret) => ({
          _id: ret._id,
          returnNumber: ret.returnNumber,
          status: ret.status,
          items: ret.items.map((item) => ({
            product: item.product?._id || item.product,
            productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
            productNameEn: item.product?.nameEn,
            quantity: item.quantity,
            reason: item.reason,
          })),
          reason: ret.reason,
          createdAt: new Date(ret.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
        })),
      };

      console.log('جلب بيع - تم بنجاح:', { saleId: id, userId: req.user.id });

      res.json(transformedSale);
    } catch (err) {
      console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Update sale
router.put(
  '/:id',
  [
    auth,
    authorize('branch'),
    body('items').optional().isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.product').optional().isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').optional().isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').optional().isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
    body('totalAmount').optional().isFloat({ min: 0 }).withMessage('الإجمالي يجب أن يكون رقمًا غير سالب'),
    body('status').optional().isIn(['completed', 'pending', 'cancelled']).withMessage('الحالة غير صالحة'),
    body('paymentMethod').optional().isString().withMessage('طريقة الدفع يجب أن تكون نصًا'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.log('تحديث البيع - أخطاء التحقق:', errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;
      const { items, totalAmount, status, paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      if (!isValidObjectId(id)) {
        console.log('تحديث البيع - معرف البيع غير صالح:', { id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف البيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        console.log('تحديث البيع - البيع غير موجود:', { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
        console.log('تحديث البيع - غير مخول:', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث هذا البيع' : 'Unauthorized to update this sale' });
      }

      const oldStatus = sale.status;
      sale.items = items ? items.map((item) => ({
        product: item.product,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })) : sale.items;
      sale.totalAmount = totalAmount || sale.totalAmount;
      sale.status = status || sale.status;
      sale.paymentMethod = paymentMethod || sale.paymentMethod;
      sale.customerName = customerName?.trim() || sale.customerName;
      sale.customerPhone = customerPhone?.trim() || sale.customerPhone;
      sale.notes = notes?.trim() || sale.notes;

      // Validate inventory for new items if status is completed
      if (status === 'completed' && items) {
        for (const item of items) {
          const inventory = await Inventory.findOne({ product: item.product, branch: sale.branch }).session(session);
          if (!inventory || inventory.currentStock < item.quantity) {
            console.log('تحديث البيع - الكمية غير كافية:', { product: item.product, currentStock: inventory?.currentStock, requestedQuantity: item.quantity });
            await session.abortTransaction();
            return res.status(400).json({
              success: false,
              message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient stock for product ${item.product}`,
            });
          }
        }
      }

      await sale.save({ session });

      // If status changed to completed, deduct from inventory
      if (oldStatus !== 'completed' && sale.status === 'completed') {
        for (const item of sale.items) {
          const inventory = await Inventory.findOneAndUpdate(
            { product: item.product, branch: sale.branch },
            {
              $inc: { currentStock: -item.quantity },
              $push: {
                movements: {
                  type: 'out',
                  quantity: item.quantity,
                  reference: `بيع #${sale.saleNumber}`,
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
            action: 'sale',
            quantity: -item.quantity,
            reference: `بيع #${sale.saleNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });

          req.io?.emit('inventoryUpdated', {
            branchId: sale.branch.toString(),
            productId: item.product.toString(),
            quantity: inventory.currentStock,
            type: 'sale',
          });
        }
      } else if (oldStatus === 'completed' && sale.status !== 'completed') {
        // If status changed from completed, add back to inventory
        for (const item of sale.items) {
          const inventory = await Inventory.findOneAndUpdate(
            { product: item.product, branch: sale.branch },
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
      }

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

      populatedSale.branch.displayName = isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name);
      populatedSale.items = populatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
            }
          : undefined,
      }));

      req.io?.emit('saleUpdated', {
        saleId: id,
        branchId: sale.branch.toString(),
        status: sale.status,
      });

      console.log('تحديث البيع - تم بنجاح:', {
        saleId: id,
        userId: req.user.id,
      });

      await session.commitTransaction();
      res.status(200).json(populatedSale);
    } catch (err) {
      await session.abortTransaction();
      console.error('خطأ في تحديث البيع:', { error: err.message, stack: err.stack, requestBody: req.body });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Delete sale
router.delete(
  '/:id',
  [auth, authorize('branch')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      if (!isValidObjectId(id)) {
        console.log('حذف البيع - معرف البيع غير صالح:', { id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف البيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        console.log('حذف البيع - البيع غير موجود:', { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
        console.log('حذف البيع - غير مخول:', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لحذف هذا البيع' : 'Unauthorized to delete this sale' });
      }

      if (sale.status === 'completed') {
        for (const item of sale.items) {
          const inventory = await Inventory.findOneAndUpdate(
            { product: item.product, branch: sale.branch },
            {
              $inc: { currentStock: item.quantity },
              $push: {
                movements: {
                  type: 'in',
                  quantity: item.quantity,
                  reference: `حذف بيع #${sale.saleNumber}`,
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
            action: 'sale_deleted',
            quantity: item.quantity,
            reference: `حذف بيع #${sale.saleNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });

          req.io?.emit('inventoryUpdated', {
            branchId: sale.branch.toString(),
            productId: item.product.toString(),
            quantity: inventory.currentStock,
            type: 'sale_deleted',
          });
        }
      }

      await sale.deleteOne({ session });

      req.io?.emit('saleDeleted', {
        saleId: id,
        branchId: sale.branch.toString(),
      });

      console.log('حذف البيع - تم بنجاح:', {
        saleId: id,
        userId: req.user.id,
      });

      await session.commitTransaction();
      res.status(200).json({ success: true, message: isRtl ? 'تم حذف البيع بنجاح' : 'Sale deleted successfully' });
    } catch (err) {
      await session.abortTransaction();
      console.error('خطأ في حذف البيع:', { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Get sales analytics
router.get(
  '/analytics',
  [
    auth,
    authorize('admin'),
    query('branch').optional().custom(isValidObjectId).withMessage('معرف الفرع غير صالح'),
    query('startDate').optional().isDate().withMessage('تاريخ البداية غير صالح'),
    query('endDate').optional().isDate().withMessage('تاريخ النهاية غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'خطأ في التحقق من المعلمات', errors: errors.array() });
    }

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
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      const branchSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$branch',
            totalSales: { $sum: '$totalAmount' },
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
          },
        },
      ]);

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
            productId: '$_id',
            productName: '$product.name',
            productNameEn: '$product.nameEn',
            displayName: isRtl ? '$product.name' : { $ifNull: ['$product.nameEn', '$product.name'] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: -1 } },
      ]);

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
        { $unwind: '$product' },
        {
          $group: {
            _id: '$product.department',
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
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
        { $unwind: '$department' },
        {
          $project: {
            departmentId: '$_id',
            departmentName: '$department.name',
            departmentNameEn: '$department.nameEn',
            displayName: isRtl ? '$department.name' : { $ifNull: ['$department.nameEn', '$department.name'] },
            totalRevenue: 1,
          },
        },
      ]);

      const totalSales = await Sale.aggregate([
        { $match: query },
        { $group: { _id: null, totalSales: { $sum: '$totalAmount' } } },
      ]);

      const topProduct = productSales.length > 0 ? productSales[0] : { productId: null, productName: 'غير معروف', displayName: isRtl ? 'غير معروف' : 'Unknown', totalQuantity: 0 };

      res.json({
        branchSales,
        productSales,
        departmentSales,
        totalSales: totalSales[0]?.totalSales || 0,
        topProduct,
      });
    } catch (err) {
      console.error('خطأ في جلب إحصائيات المبيعات:', { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

module.exports = router;