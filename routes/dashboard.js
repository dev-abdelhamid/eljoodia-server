const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');
const Sale = require('../models/Sale');
const User = require('../models/User');
const ProductionAssignment = require('../models/ProductionAssignment');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Middleware to ensure authentication and authorization
router.use(auth);
router.use(authorize(['admin', 'branch', 'chef', 'production']));

// Dashboard Statistics
router.get('/stats', async (req, res) => {
  try {
    const query = req.user.role === 'branch' ? { branch: req.user.branchId } : {};
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayQuery = { ...query, createdAt: { $gte: new Date(todayStart) } };

    const [
      totalOrders,
      dailyOrders,
      totalSales,
      dailySales,
      lowStockItems,
      pendingReturns,
      activeChefs,
      totalTasks,
      completedTasks,
      inProgressTasks,
      inProduction,
      completedToday,
      pendingReviews,
    ] = await Promise.all([
      Order.countDocuments(query),
      Order.countDocuments(todayQuery),
      Sale.aggregate([
        { $match: query },
        { $group: { _id: null, totalAmount: { $sum: '$totalAmount' } } },
      ]),
      Sale.aggregate([
        { $match: todayQuery },
        { $group: { _id: null, totalAmount: { $sum: '$totalAmount' } } },
      ]),
      Inventory.find({ ...query, currentStock: { $lte: '$minStockLevel' } }).countDocuments(),
      Return.countDocuments({ ...query, status: 'pending_approval' }),
      User.countDocuments({ role: 'chef', isActive: true }),
      ProductionAssignment.countDocuments(req.user.role === 'chef' ? { chef: req.user.id } : query),
      ProductionAssignment.countDocuments({
        ...(req.user.role === 'chef' ? { chef: req.user.id } : query),
        status: 'completed',
      }),
      ProductionAssignment.countDocuments({
        ...(req.user.role === 'chef' ? { chef: req.user.id } : query),
        status: 'in_progress',
      }),
      Order.countDocuments({ ...query, status: 'in_production' }),
      Order.countDocuments({ ...todayQuery, status: 'completed' }),
      Return.countDocuments({ ...query, status: 'pending_approval' }),
    ]);

    const stats = {
      totalOrders,
      dailyOrders,
      totalSales: totalSales[0]?.totalAmount || 0,
      dailySales: dailySales[0]?.totalAmount || 0,
      lowStockItems,
      pendingReturns,
      activeChefs,
      totalTasks,
      completedTasks,
      inProgressTasks,
      inProduction,
      completedToday,
      pendingReviews,
    };

    console.log(`[${new Date().toISOString()}] Dashboard stats fetched:`, {
      userId: req.user.id,
      role: req.user.role,
      stats,
    });

    res.status(200).json(stats);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching dashboard stats:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Recent Orders
router.get('/recent-orders', async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const query = req.user.role === 'branch' ? { branch: req.user.branchId } : {};
    const orders = await Order.find(query)
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit',
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    const formattedOrders = orders.map(order => ({
      _id: order._id,
      orderNumber: order.orderNumber || order._id,
      branchName: order.branch?.name || 'Unknown',
      itemsCount: order.items?.length || 0,
      totalAmount: order.adjustedTotal || 0,
      status: order.status,
      createdAt: new Date(order.createdAt).toISOString(),
    }));

    console.log(`[${new Date().toISOString()}] Recent orders fetched:`, {
      count: orders.length,
      userId: req.user.id,
      role: req.user.role,
    });

    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching recent orders:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Branch Performance
router.get('/branches-performance', async (req, res) => {
  try {
    const query = req.user.role === 'branch' ? { _id: req.user.branchId } : {};
    const branches = await Branch.find(query).select('name').lean();
    const branchIds = branches.map(branch => branch._id);

    const performance = await Promise.all(
      branchIds.map(async (branchId) => {
        const [orderCount, salesTotal, lowStockCount] = await Promise.all([
          Order.countDocuments({ branch: branchId }),
          Sale.aggregate([
            { $match: { branch: branchId } },
            { $group: { _id: null, totalAmount: { $sum: '$totalAmount' } } },
          ]),
          Inventory.find({ branch: branchId, currentStock: { $lte: '$minStockLevel' } }).countDocuments(),
        ]);

        // Calculate performance as a percentage (e.g., based on order count relative to max)
        const maxOrders = 200; // Example max value for normalization
        const performance = Math.min((orderCount / maxOrders) * 100, 100);

        return {
          _id: branchId,
          name: branches.find(b => b._id.toString() === branchId.toString())?.name || 'Unknown',
          orderCount,
          salesTotal: salesTotal[0]?.totalAmount || 0,
          lowStockCount,
          performance,
        };
      })
    );

    console.log(`[${new Date().toISOString()}] Branch performance fetched:`, {
      count: performance.length,
      userId: req.user.id,
      role: req.user.role,
    });

    res.status(200).json(performance);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching branch performance:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Pending Reviews (Returns)
router.get('/pending-reviews', async (req, res) => {
  try {
    const query = req.user.role === 'branch' ? { branch: req.user.branchId, status: 'pending_approval' } : { status: 'pending_approval' };
    const returns = await Return.find(query)
      .populate('order', 'orderNumber')
      .populate({
        path: 'items.product',
        select: 'name price unit',
      })
      .populate('branch', 'name')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const formattedReturns = returns.map(returnDoc => ({
      _id: returnDoc._id,
      orderNumber: returnDoc.order?.orderNumber || returnDoc._id,
      branchName: returnDoc.branch?.name || 'Unknown',
      itemsCount: returnDoc.items?.length || 0,
      status: returnDoc.status,
      createdAt: new Date(returnDoc.createdAt).toISOString(),
    }));

    console.log(`[${new Date().toISOString()}] Pending reviews fetched:`, {
      count: returns.length,
      userId: req.user.id,
      role: req.user.role,
    });

    res.status(200).json(formattedReturns);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching pending reviews:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Top Products
router.get('/top-products', async (req, res) => {
  try {
    const { branchId } = req.query;
    const query = req.user.role === 'branch' ? { branch: req.user.branchId } : branchId ? { branch: branchId } : {};
    const topProducts = await Sale.aggregate([
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
          _id: '$_id',
          name: '$product.name',
          totalQuantity: 1,
          totalRevenue: 1,
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 },
    ]);

    console.log(`[${new Date().toISOString()}] Top products fetched:`, {
      count: topProducts.length,
      userId: req.user.id,
      role: req.user.role,
    });

    res.status(200).json(topProducts);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching top products:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Chef Performance
router.get('/chefs-performance', async (req, res) => {
  try {
    const query = req.user.role === 'branch' ? { branch: req.user.branchId } : {};
    const chefPerformance = await ProductionAssignment.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$chef',
          totalTasks: { $sum: 1 },
          completedTasks: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          totalQuantity: { $sum: '$quantity' },
        },
      },
      {
        $lookup: {
          from: 'chefs',
          localField: '_id',
          foreignField: '_id',
          as: 'chef',
        },
      },
      { $unwind: '$chef' },
      {
        $lookup: {
          from: 'users',
          localField: 'chef.user',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $lookup: {
          from: 'departments',
          localField: 'chef.department',
          foreignField: '_id',
          as: 'department',
        },
      },
      { $unwind: '$department' },
      {
        $project: {
          _id: '$chef._id',
          name: '$user.username',
          department: '$department.name',
          totalTasks: 1,
          completedTasks: 1,
          totalQuantity: 1,
          completionRate: {
            $cond: [
              { $eq: ['$totalTasks', 0] },
              0,
              { $divide: ['$completedTasks', '$totalTasks'] },
            ],
          },
        },
      },
      { $sort: { completedTasks: -1 } },
      { $limit: 5 },
    ]);

    console.log(`[${new Date().toISOString()}] Chef performance fetched:`, {
      count: chefPerformance.length,
      userId: req.user.id,
      role: req.user.role,
    });

    res.status(200).json(chefPerformance);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef performance:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Chef Tasks
router.get('/chef-tasks/:chefId', async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }
    if (req.user.role === 'chef' && req.user.id !== chefId) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بمشاهدة مهام شيف آخر' });
    }
    const query = { chef: chefId };
    if (req.user.role === 'branch' && req.user.branchId) {
      query.branch = req.user.branchId;
    }
    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const formattedTasks = tasks.map(task => ({
      _id: task._id,
      orderId: task.order?._id,
      orderNumber: task.order?.orderNumber || task._id,
      productName: task.product?.name || 'Unknown',
      quantity: task.quantity,
      status: task.status,
      description: task.product?.name || 'No description',
      createdAt: new Date(task.createdAt).toISOString(),
    }));

    console.log(`[${new Date().toISOString()}] Chef tasks fetched:`, {
      count: tasks.length,
      chefId,
      userId: req.user.id,
      role: req.user.role,
    });

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      chefId: req.params.chefId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;