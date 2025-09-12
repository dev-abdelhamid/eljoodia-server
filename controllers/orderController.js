const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { check, validationResult } = require('express-validator');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const { auth, authorize } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');
const { isValidObjectId, validateStatusTransition, emitSocketEvent, notifyUsers } = require('../utils/common');

router.post(
  '/',
  [
    auth,
    authorize(['admin', 'branch']),
    check('branchId').isMongoId().withMessage('معرف الفرع غير صالح'),
    check('items').isArray({ min: 1 }).withMessage('يجب أن يحتوي الطلب على عنصر واحد على الأقل'),
    check('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    check('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عدد صحيح أكبر من 0'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] Validation errors in POST /orders:`, errors.array());
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { branchId, items, notes } = req.body;
      console.log(`[${new Date().toISOString()}] Creating order for branch ${branchId}:`, { items, notes });

      if (!isValidObjectId(branchId)) {
        throw new Error('معرف الفرع غير صالح');
      }

      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        throw new Error('الفرع غير موجود');
      }

      const mergedItems = [];
      const productIds = [...new Set(items.map((item) => item.productId))];
      const products = await Product.find({ _id: { $in: productIds } })
        .select('name price branch')
        .session(session)
        .lean();

      for (const item of items) {
        const product = products.find((p) => p._id.toString() === item.productId);
        if (!product) {
          throw new Error(`المنتج ${item.productId} غير موجود`);
        }
        if (product.branch.toString() !== branchId) {
          throw new Error(`المنتج ${product.name} لا ينتمي إلى الفرع ${branchId}`);
        }

        const existingItem = mergedItems.find((merged) => merged.productId === item.productId);
        if (existingItem) {
          existingItem.quantity += item.quantity;
        } else {
          mergedItems.push({
            productId: item.productId,
            productName: product.name,
            quantity: item.quantity,
            price: product.price,
            status: 'pending',
          });
        }
      }

      const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      const order = new Order({
        orderNumber,
        branch: branchId,
        items: mergedItems,
        status: 'pending',
        notes: notes || '',
        createdBy: req.user.id,
        statusHistory: [{ status: 'pending', changedBy: req.user.id, changedAt: new Date() }],
      });

      await order.save({ session });
      console.log(`[${new Date().toISOString()}] Order created: ${order._id}, Order Number: ${orderNumber}`);

      const eventData = {
        orderId: order._id.toString(),
        orderNumber,
        branchId,
        eventId: `${order._id}-orderCreated`,
      };

      await createNotification(
        req.user.id,
        'success',
        'orderCreated',
        'notifications.order_created',
        { orderNumber, branchName: branch.name },
        eventData,
        req.app.get('io'),
        true
      );

      await notifyUsers(req.app.get('io'), ['admin', 'branch', 'production'], branchId, null, null, 'orderCreated', eventData);
      await syncOrderTasks(order._id, session);

      await session.commitTransaction();
      res.status(201).json({ success: true, data: order });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error creating order:`, {
        error: err.message,
        stack: err.stack,
        userId: req.user?.id,
        branchId: req.body.branchId,
      });
      res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

router.get('/', [auth, authorize(['admin', 'branch', 'production', 'chef'])], async (req, res) => {
  try {
    const { page = 1, limit = 100, branchId, status, startDate, endDate } = req.query;
    const query = {};

    if (branchId && isValidObjectId(branchId)) query.branch = branchId;
    if (status) query.status = status;
    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('branch', 'name')
      .populate('items.productId', 'name')
      .populate('createdBy', 'username')
      .lean();

    const total = await Order.countDocuments(query);

    res.json({
      success: true,
      data: orders,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
      error: err.message,
      stack: err.stack,
      userId: req.user?.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/:id', [auth, authorize(['admin', 'branch', 'production', 'chef'])], async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'معرف الطلب غير صالح' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name')
      .populate('items.productId', 'name')
      .populate('createdBy', 'username')
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order ${req.params.id}:`, {
      error: err.message,
      stack: err.stack,
      userId: req.user?.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/check/:orderNumber', [auth, authorize(['admin', 'branch'])], async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const order = await Order.findOne({ orderNumber }).lean();
    res.json({ success: true, exists: !!order });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order ${req.params.orderNumber}:`, {
      error: err.message,
      stack: err.stack,
      userId: req.user?.id,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;