const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create a sale
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('branch').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.product').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error('إنشاء بيع - أخطاء التحقق:', errors.array());
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { branch, items, notes, paymentMethod, customerName, customerPhone } = req.body;

      // Validate branch for branch users
      if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
        console.error('إنشاء بيع - غير مخول أو لا يوجد فرع مخصص:', {
          userId: req.user.id,
          branch,
          userBranchId: req.user.branchId,
        });
        return res.status(403).json({ success: false, message: 'errors.no_branch_assigned' });
      }

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Verify branch exists
        const branchDoc = await Branch.findById(branch).session(session);
        if (!branchDoc) {
          await session.abortTransaction();
          console.error('إنشاء بيع - الفرع غير موجود:', { branch });
          return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
        }

        // Validate inventory for each item
        for (const item of items) {
          const product = await Product.findById(item.product).session(session);
          if (!product) {
            await session.abortTransaction();
            console.error('إنشاء بيع - المنتج غير موجود:', { productId: item.product });
            return res.status(404).json({ success: false, message: `المنتج ${item.product} غير موجود` });
          }
          const inventoryItem = await Inventory.findOne({ branch, product: item.product }).session(session);
          if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
            await session.abortTransaction();
            console.error('إنشاء بيع - الكمية غير كافية:', {
              productId: item.product,
              currentStock: inventoryItem?.currentStock,
              requestedQuantity: item.quantity,
            });
            return res.status(400).json({
              success: false,
              message: `الكمية غير كافية في المخزون للمنتج ${item.product}`,
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
            product: item.product,
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

        // Update inventory
        for (const item of items) {
          await Inventory.findOneAndUpdate(
            { branch, product: item.product },
            { $inc: { currentStock: -item.quantity } },
            { new: true, session }
          );
        }

        await session.commitTransaction();

        const populatedSale = await Sale.findById(newSale._id)
          .populate('branch', 'name nameEn')
          .populate({
            path: 'items.product',
            select: 'name nameEn price unit unitEn department',
            populate: { path: 'department', select: 'name nameEn code' },
          })
          .populate('createdBy', 'username')
          .lean();

        const isRtl = req.query.lang === 'ar';
        req.io?.emit('saleCreated', {
          saleId: newSale._id,
          branchId: branch,
          saleNumber,
          items,
          totalAmount: newSale.totalAmount,
          createdAt: newSale.createdAt,
        });

        console.log('إنشاء بيع - تم بنجاح:', {
          saleId: newSale._id,
          branchId: branch,
          itemsCount: items.length,
        });

        res.status(201).json({
          ...populatedSale,
          branchName: isRtl ? populatedSale.branch.name : populatedSale.branch.nameEn || populatedSale.branch.name,
          items: populatedSale.items.map(item => ({
            ...item,
            productName: isRtl ? item.product.name : item.product.nameEn || item.product.name,
            unit: isRtl ? item.product.unit : item.product.unitEn || item.product.unit,
          })),
        });
      } catch (err) {
        await session.abortTransaction();
        console.error('إنشاء بيع - خطأ:', { error: err.message, stack: err.stack });
        throw err;
      } finally {
        session.endSession();
      }
    } catch (err) {
      console.error('خطأ في إنشاء المبيعة:', { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// Get sales analytics
router.get(
  '/analytics',
  [auth, authorize('admin')],
  async (req, res) => {
    try {
      const { branch, startDate, endDate, page = 1, limit = 100 } = req.query;
      const query = {};
      const isRtl = req.query.lang === 'ar';

      if (branch && !isValidObjectId(branch)) {
        console.log('جلب تحليلات المبيعات - معرف الفرع غير صالح:', branch);
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      if (branch) query.branch = branch;
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) {
          const start = new Date(startDate);
          if (isNaN(start.getTime())) {
            console.log('جلب تحليلات المبيعات - تاريخ البداية غير صالح:', startDate);
            return res.status(400).json({ success: false, message: isRtl ? 'تاريخ البداية غير صالح' : 'Invalid start date' });
          }
          query.createdAt.$gte = start;
        }
        if (endDate) {
          const end = new Date(endDate);
          if (isNaN(end.getTime())) {
            console.log('جلب تحليلات المبيعات - تاريخ النهاية غير صالح:', endDate);
            return res.status(400).json({ success: false, message: isRtl ? 'تاريخ النهاية غير صالح' : 'Invalid end date' });
          }
          query.createdAt.$lte = end;
        }
      }

      const sales = await Sale.find(query)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn price unit unitEn department',
          populate: { path: 'department', select: 'name nameEn code' },
        })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean();

      const branchSales = [];
      const productSales = [];
      const departmentSales = [];

      sales.forEach((sale) => {
        const branchId = sale.branch._id.toString();
        const branchName = isRtl ? sale.branch.name : sale.branch.nameEn || sale.branch.name;
        let branch = branchSales.find((b) => b.branchId === branchId);
        if (!branch) {
          branch = { branchId, branchName, totalSales: 0, totalQuantity: 0 };
          branchSales.push(branch);
        }
        branch.totalSales += sale.totalAmount;
        branch.totalQuantity += sale.items.reduce((sum, item) => sum + item.quantity, 0);

        sale.items.forEach((item) => {
          const productId = item.product._id.toString();
          const productName = isRtl ? item.product.name : item.product.nameEn || item.product.name;
          const departmentId = item.product.department?._id?.toString() || 'unknown';
          const departmentName = isRtl ? item.product.department?.name : item.product.department?.nameEn || item.product.department?.name || 'غير معروف';

          let product = productSales.find((p) => p.productId === productId);
          if (!product) {
            product = { productId, productName, totalQuantity: 0, totalRevenue: 0 };
            productSales.push(product);
          }
          product.totalQuantity += item.quantity;
          product.totalRevenue += item.quantity * item.unitPrice;

          let department = departmentSales.find((d) => d.departmentId === departmentId);
          if (!department) {
            department = { departmentId, departmentName, totalRevenue: 0, totalQuantity: 0 };
            departmentSales.push(department);
          }
          department.totalRevenue += item.quantity * item.unitPrice;
          department.totalQuantity += item.quantity;
        });
      });

      branchSales.sort((a, b) => b.totalSales - a.totalSales);
      productSales.sort((a, b) => b.totalRevenue - a.totalRevenue);
      departmentSales.sort((a, b) => b.totalRevenue - a.totalRevenue);

      const total = await Sale.countDocuments(query);

      console.log('جلب تحليلات المبيعات - تم بنجاح:', {
        branchSalesCount: branchSales.length,
        productSalesCount: productSales.length,
        departmentSalesCount: departmentSales.length,
        userId: req.user.id,
        query,
        page,
        limit,
      });

      res.status(200).json({ branchSales, productSales, departmentSales, total });
    } catch (err) {
      console.error('خطأ في جلب تحليلات المبيعات:', { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Get all sales
router.get(
  '/',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { branch, startDate, endDate, page = 1, limit = 10 } = req.query;
      const query = {};
      const isRtl = req.query.lang === 'ar';

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

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      const sales = await Sale.find(query)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn price unit unitEn department',
          populate: { path: 'department', select: 'name nameEn code' },
        })
        .populate('createdBy', 'username')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean();

      const total = await Sale.countDocuments(query);

      const formattedSales = sales.map(sale => ({
        ...sale,
        branchName: isRtl ? sale.branch.name : sale.branch.nameEn || sale.branch.name,
        items: sale.items.map(item => ({
          ...item,
          productName: isRtl ? item.product.name : item.product.nameEn || item.product.name,
          unit: isRtl ? item.product.unit : item.product.unitEn || item.product.unit,
        })),
      }));

      console.log('جلب المبيعات - تم جلب المبيعات:', {
        count: sales.length,
        total,
        userId: req.user.id,
        query,
      });

      res.status(200).json({ sales: formattedSales, total });
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
      const isRtl = req.query.lang === 'ar';
      if (!isValidObjectId(id)) {
        console.log('جلب البيع - معرف البيع غير صالح:', id);
        return res.status(400).json({ success: false, message: isRtl ? 'معرف المبيعة غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn price unit unitEn department',
          populate: { path: 'department', select: 'name nameEn code' },
        })
        .populate('createdBy', 'username')
        .lean();

      if (!sale) {
        console.log('جلب البيع - البيع غير موجود:', id);
        return res.status(404).json({ success: false, message: isRtl ? 'المبيعة غير موجودة' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId.toString()) {
        console.log('جلب البيع - غير مخول:', {
          userId: req.user.id,
          branchId: sale.branch._id,
          userBranchId: req.user.branchId,
        });
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى هذه المبيعة' : 'Not authorized to access this sale' });
      }

      const formattedSale = {
        ...sale,
        branchName: isRtl ? sale.branch.name : sale.branch.nameEn || sale.branch.name,
        items: sale.items.map(item => ({
          ...item,
          productName: isRtl ? item.product.name : item.product.nameEn || item.product.name,
          unit: isRtl ? item.product.unit : item.product.unitEn || item.product.unit,
        })),
      };

      console.log('جلب البيع - تم بنجاح:', { saleId: id, userId: req.user.id });

      res.status(200).json(formattedSale);
    } catch (err) {
      console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

module.exports = router;