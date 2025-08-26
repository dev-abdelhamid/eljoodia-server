const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, query, validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع المبيعات
router.get(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    query('branch').optional().isMongoId().withMessage('معرف الفرع غير صالح'),
    query('startDate').optional().isISO8601().toDate().withMessage('تاريخ البداية غير صالح'),
    query('endDate').optional().isISO8601().toDate().withMessage('تاريخ النهاية غير صالح'),
    query('page').optional().isInt({ min: 1 }).toInt().withMessage('رقم الصفحة غير صالح'),
    query('limit').optional().isInt({ min: 1 }).toInt().withMessage('الحد غير صالح'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { branch, startDate, endDate, page = 1, limit = 10 } = req.query;
      const query = {};

      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') {
        if (!req.user.branchId) {
          return res.status(400).json({ success: false, message: 'errors.no_branch_assigned' });
        }
        query.branch = req.user.branchId;
      }
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      const sales = await Sale.find(query)
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const total = await Sale.countDocuments(query);

      res.status(200).json({ sales, total });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching sales:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// إنشاء مبيعة
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
    body('notes').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { branch, items, notes } = req.body;

      if (req.user.role === 'branch' && branch !== req.user.branchId.toString()) {
        return res.status(403).json({ success: false, message: 'غير مخول لإنشاء مبيعة لهذا الفرع' });
      }

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        for (const item of items) {
          const inventoryItem = await Inventory.findOne({ branch, product: item.productId }).session(session);
          if (!inventoryItem || inventoryItem.currentStock < item.quantity) {
            await session.abortTransaction();
            return res.status(400).json({
              success: false,
              message: `الكمية غير كافية في المخزون للمنتج ${item.productId}`,
              error: 'insufficient_stock',
            });
          }
        }

        const saleCount = await Sale.countDocuments();
        const orderNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;

        const newSale = new Sale({
          orderNumber,
          branch,
          items: items.map((item) => ({
            product: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
          totalAmount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
          status: 'completed',
          createdBy: req.user.id,
          notes: notes?.trim(),
        });

        await newSale.save({ session });

        for (const item of items) {
          await Inventory.findOneAndUpdate(
            { branch, product: item.productId },
            {
              $inc: { currentStock: -item.quantity },
              $push: {
                movements: {
                  type: 'sale',
                  quantity: -item.quantity,
                  reference: orderNumber,
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
            reference: `مبيعة #${orderNumber}`,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });
        }

        await session.commitTransaction();

        const populatedSale = await Sale.findById(newSale._id)
          .populate('branch', 'name')
          .populate('items.product', 'name price')
          .lean();

        req.io?.emit('saleCreated', {
          saleId: newSale._id,
          branchId: branch,
          orderNumber,
          items,
          totalAmount: newSale.totalAmount,
          createdAt: newSale.createdAt,
        });

        res.status(201).json(populatedSale);
      } catch (err) {
        await session.abortTransaction();
        throw err;
      } finally {
        session.endSession();
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error creating sale:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// جلب تفاصيل مبيعة
router.get(
  '/:id',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: 'معرف المبيعة غير صالح' });
      }

      const sale = await Sale.findById(id)
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .lean();

      if (!sale) {
        return res.status(404).json({ success: false, message: 'المبيعة غير موجودة' });
      }

      if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId.toString()) {
        return res.status(403).json({ success: false, message: 'غير مخول للوصول إلى هذه المبيعة' });
      }

      res.status(200).json(sale);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching sale:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

// تحليلات المبيعات
router.get(
  '/analytics',
  [auth, authorize('admin')],
  async (req, res) => {
    try {
      const { startDate, endDate, branch } = req.query;
      const query = {};

      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      const sales = await Sale.find(query)
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .lean();

      const totalSales = sales.reduce((sum, sale) => sum + (sale.totalAmount || 0), 0);
      const salesByBranch = {};
      const salesByProduct = {};

      sales.forEach((sale) => {
        const branchId = sale.branch._id.toString();
        const branchName = sale.branch.name;

        if (!salesByBranch[branchId]) {
          salesByBranch[branchId] = { name: branchName, total: 0, count: 0 };
        }
        salesByBranch[branchId].total += sale.totalAmount || 0;
        salesByBranch[branchId].count += 1;

        sale.items.forEach((item) => {
          const productId = item.product._id.toString();
          const productName = item.product.name;
          if (!salesByProduct[productId]) {
            salesByProduct[productId] = { name: productName, totalQuantity: 0, totalRevenue: 0 };
          }
          salesByProduct[productId].totalQuantity += item.quantity;
          salesByProduct[productId].totalRevenue += item.quantity * item.unitPrice;
        });
      });

      const analytics = {
        totalSales,
        totalCount: sales.length,
        salesByBranch: Object.values(salesByBranch),
        salesByProduct: Object.values(salesByProduct),
        salesTrend: sales
          .reduce((acc, sale) => {
            const date = new Date(sale.createdAt).toISOString().slice(0, 10);
            if (!acc[date]) acc[date] = { date, total: 0, count: 0 };
            acc[date].total += sale.totalAmount || 0;
            acc[date].count += 1;
            return acc;
          }, {})
      };

      res.status(200).json(analytics);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching sales analytics:`, err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

module.exports = router;