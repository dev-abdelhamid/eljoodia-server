const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const { body, validationResult } = require('express-validator');

router.post(
  '/',
  [
    authMiddleware.auth,
    authMiddleware.authorize('branch'),
    body('items').isArray({ min: 1 }).withMessage('مطلوب مصفوفة من العناصر'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عدد صحيح إيجابي'),
    body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا إيجابيًا'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { items, paymentMethod, customerName, customerPhone, notes } = req.body;

      for (const item of items) {
        const inventory = await Inventory.findOne({
          branch: req.user.branchId,
          product: item.productId,
        });
        if (!inventory) {
          return res.status(400).json({ message: `المخزون للمنتج ${item.productId} غير موجود` });
        }
        if (inventory.currentStock < item.quantity) {
          return res.status(400).json({ message: `المخزون غير كافٍ للمنتج ${item.productId}` });
        }
      }

      const saleCount = await Sale.countDocuments();
      const saleNumber = `SALE-${new Date().toISOString().slice(0, 10)}-${saleCount + 1}`;
      const totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

      const sale = new Sale({
        saleNumber,
        branch: req.user.branchId,
        items,
        totalAmount,
        paymentMethod,
        customerName,
        customerPhone,
        notes,
        createdBy: req.user.id,
      });

      await sale.save();

      for (const item of items) {
        await Inventory.findOneAndUpdate(
          { branch: req.user.branchId, product: item.productId },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'sale',
                quantity: -item.quantity,
                reference: saleNumber,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true }
        );
      }

      const populatedSale = await Sale.findById(sale._id)
        .populate('branch', 'name')
        .populate('items.productId', 'name code')
        .populate('createdBy', 'username')
        .lean();

      req.io?.emit('inventoryUpdated', {
        branchId: req.user.branchId,
      });

      res.status(201).json(populatedSale);
    } catch (err) {
      console.error('Error creating sale:', err);
      res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
    }const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// جلب جميع المبيعات
router.get(
  '/',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { branch, page = 1, limit = 10 } = req.query;
      const query = {};
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') {
        if (!req.user.branchId) {
          return res.status(400).json({ success: false, message: 'errors.no_branch_assigned' });
        }
        query.branch = req.user.branchId;
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
      console.error('Error fetching sales:', err);
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
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'خطأ في التحقق من البيانات', errors: errors.array() });
      }

      const { branch, items, notes } = req.body;

      if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
        return res.status(403).json({ success: false, message: 'errors.no_branch_assigned' });
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
      console.error('خطأ في إنشاء المبيعة:', err);
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
      console.error('خطأ في جلب تفاصيل المبيعة:', err);
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

module.exports = router;
  }
);

router.get(
  '/',
  [authMiddleware.auth, authMiddleware.authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { branch, startDate, endDate, page = 1, limit = 10 } = req.query;
      const query = {};
      if (branch && mongoose.isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;
      if (startDate && endDate) {
        query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
      }

      const sales = await Sale.find(query)
        .populate('branch', 'name')
        .populate('items.productId', 'name code')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean();

      const total = await Sale.countDocuments(query);
      res.status(200).json({ sales, total });
    } catch (err) {
      console.error('Error fetching sales:', err);
      res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
    }
  }
);

module.exports = router;