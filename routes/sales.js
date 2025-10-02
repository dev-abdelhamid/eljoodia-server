const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
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
    body('branch').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
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

      const { branch, items, notes, paymentMethod, customerName, customerPhone, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      // Validate branch for branch users
      if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
        console.error('إنشاء بيع - غير مخول أو لا يوجد فرع مخصص:', {
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
        console.error('إنشاء بيع - الفرع غير موجود:', { branch });
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      // Validate inventory for each item
      for (const item of items) {
        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          await session.abortTransaction();
          console.error('إنشاء بيع - المنتج غير موجود:', { productId: item.productId });
          return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
        }
        const inventoryItem = await Inventory.findOne({ branch, product: item.productId }).session(session);
        if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
          await session.abortTransaction();
          console.error('إنشاء بيع - الكمية غير كافية:', {
            productId: item.productId,
            currentStock: inventoryItem?.currentStock,
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

      // Update inventory
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
      const { branch, startDate, endDate, page = 1, limit = 20, sort = '-createdAt', lang = 'ar' } = req.query;
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

      res.json({ sales: transformedSales, total, returns });
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

      res.json(transformedSale);
    } catch (err) {
      console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Get sales analytics
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
