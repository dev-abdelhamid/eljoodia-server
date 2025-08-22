const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const Return = require('../models/Return');
const Order = require('../models/Order');
const mongoose = require('mongoose');
const { processReturn } = require('../controllers/returnsController');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Get all returns
router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { status, branch, page = 1, limit = 10 } = req.query;
      const query = {};
      if (status) query.status = status;
      if (branch && isValidObjectId(branch)) query.branch = branch;
      if (req.user.role === 'branch') query.branch = req.user.branchId;

      const returns = await Return.find(query)
        .populate('order', 'orderNumber totalAmount branch')
        .populate('branch', 'name')
        .populate('items.product', 'name price')
        .populate('createdBy', 'username')
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .lean()
        .session(session);

      const total = await Return.countDocuments(query).session(session);

      await session.commitTransaction();
      res.status(200).json({ returns, total });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error fetching returns: ${err.message}`);
      res.status(500).json({ success: false, message: 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Create a return
router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('orderId').isMongoId().withMessage('Invalid order ID'),
    body('branchId').isMongoId().withMessage('Invalid branch ID'),
    body('reason').notEmpty().withMessage('Reason is required'),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('items.*.reason').notEmpty().withMessage('Item return reason is required'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new Error('Validation errors: ' + JSON.stringify(errors.array()));
      }

      const { orderId, branchId, reason, items, notes } = req.body;

      // Validate order and permissions
      const order = await Order.findById(orderId)
        .populate('items.product')
        .session(session);
      if (!order) {
        throw new Error('Order not found');
      }
      if (order.status !== 'delivered') {
        throw new Error('Order must be delivered to create a return');
      }
      if (order.branch.toString() !== branchId || (req.user.role === 'branch' && branchId !== req.user.branchId.toString())) {
        throw new Error('Unauthorized to create return for this order');
      }

      // Check if order is within 3 days
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      if (new Date(order.createdAt) < threeDaysAgo) {
        throw new Error('Cannot create return for order older than 3 days');
      }

      // Validate items
      for (const item of items) {
        const orderItem = order.items.find((i) => i.product._id.toString() === item.product);
        if (!orderItem) {
          throw new Error(`Product ${item.product} not found in order`);
        }
        if (item.quantity > orderItem.quantity) {
          throw new Error(`Return quantity for product ${item.product} exceeds ordered quantity`);
        }
      }

      // Generate return number
      const returnCount = await Return.countDocuments().session(session);
      const returnNumber = `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${returnCount + 1}`;

      // Create return
      const newReturn = new Return({
        returnNumber,
        order: orderId,
        branch: branchId,
        reason,
        items: items.map((item) => ({
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
        })),
        status: 'pending',
        createdBy: req.user.id,
        notes: notes?.trim(),
      });
      await newReturn.save({ session });

      // Update order
      order.returns = order.returns || [];
      order.returns.push({
        _id: newReturn._id,
        returnNumber,
        status: 'pending',
        items: items.map((item) => ({
          product: item.product,
          quantity: item.quantity,
          reason: item.reason,
        })),
        reason,
        createdAt: new Date(),
      });
      await order.save({ session });

      // Populate return data
      const populatedReturn = await Return.findById(newReturn._id)
        .populate('order', 'orderNumber totalAmount branch')
        .populate('items.product', 'name price')
        .populate('branch', 'name')
        .populate('createdBy', 'username')
        .lean()
        .session(session);

      // Emit Socket.IO event
      const io = req.app.get('io');
      const eventData = {
        returnId: newReturn._id,
        branchId,
        orderId,
        returnNumber,
        status: 'pending',
        reason,
        returnItems: items,
        createdAt: newReturn.createdAt,
        sound: '/return-created.mp3',
        vibrate: [300, 100, 300],
      };
      io.to('admin').emit('returnCreated', eventData);
      io.to('production').emit('returnCreated', eventData);
      io.to(`branch-${branchId}`).emit('returnCreated', eventData);

      await session.commitTransaction();
      res.status(201).json(populatedReturn);
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error creating return: ${err.message}`);
      res.status(400).json({ success: false, message: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Process return (approve/reject)
router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    body('status').isIn(['approved', 'rejected']).withMessage('Status must be approved or rejected'),
    body('reviewNotes').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation errors', errors: errors.array() });
      }
      await processReturn(req, res);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error in PUT /returns/:id: ${err.message}`);
      res.status(400).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;