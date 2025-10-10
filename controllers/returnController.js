const mongoose = require('mongoose');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const generateReturnNumber = async (branchId, session) => {
  const count = await Return.countDocuments({ branch: branchId }).session(session);
  return `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(count + 1).toString().padStart(4, '0')}`;
};

const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  let retryCount = 0;
  const maxRetries = 3;

  while (retryCount <= maxRetries) {
    try {
      session.startTransaction();

      const { branchId, items, notes = '', orders = [] } = req.body;

      if (!isValidObjectId(branchId)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      if (!Array.isArray(items) || !items.length) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'العناصر مطلوبة' : 'Items are required' });
      }
      if (!Array.isArray(orders) || orders.some(id => !isValidObjectId(id))) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرفات الطلبات غير صالحة' : 'Invalid order IDs' });
      }

      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch' });
      }

      const reasonMap = {
        'تالف': 'Damaged',
        'منتج خاطئ': 'Wrong Item',
        'كمية زائدة': 'Excess Quantity',
        'أخرى': 'Other',
      };
      const productIds = items.map(item => item.product);
      const products = await Product.find({ _id: { $in: productIds } }).session(session);
      if (products.length !== productIds.length) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
      }

      const returnItems = items.map(item => {
        const product = products.find(p => p._id.toString() === item.product);
        if (!item.quantity || item.quantity < 1 || !reasonMap[item.reason]) {
          throw new Error(isRtl ? `بيانات العنصر غير صالحة: ${item.product}` : `Invalid item data for product: ${item.product}`);
        }
        return {
          product: item.product,
          quantity: item.quantity,
          price: product.price || 0,
          reason: item.reason,
          reasonEn: reasonMap[item.reason],
        };
      });

      const inventories = await Inventory.find({ branch: branchId, product: { $in: productIds } })
        .select('product currentStock pendingReturnStock __v')
        .session(session);
      for (const item of returnItems) {
        const inventory = inventories.find(inv => inv.product.toString() === item.product);
        if (!inventory || inventory.currentStock < item.quantity) {
          await session.abortTransaction();
          return res.status(422).json({
            success: false,
            message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}`,
          });
        }
      }

      const returnNumber = await generateReturnNumber(branchId, session);
      const newReturn = new Return({
        returnNumber,
        orders,
        branch: branchId,
        items: returnItems,
        status: 'pending_approval',
        createdBy: req.user.id,
        notes,
        statusHistory: [{
          status: 'pending_approval',
          changedBy: req.user.id,
          notes: isRtl ? 'تم إنشاء المرتجع' : 'Return created',
          changedAt: new Date(),
        }],
      });
      await newReturn.save({ session });

      const bulkOps = returnItems.map(item => {
        const inventory = inventories.find(inv => inv.product.toString() === item.product);
        return {
          updateOne: {
            filter: { branch: branchId, product: item.product, __v: inventory.__v },
            update: {
              $inc: {
                currentStock: -item.quantity,
                pendingReturnStock: item.quantity,
                __v: 1,
              },
              $push: {
                movements: {
                  type: 'out',
                  quantity: item.quantity,
                  reference: `مرتجع #${returnNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
          },
        };
      });

      await Inventory.bulkWrite(bulkOps, { session });

      const historyEntries = returnItems.map(item => ({
        product: item.product,
        branch: branchId,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `مرتجع #${returnNumber}`,
        referenceType: 'return',
        referenceId: newReturn._id,
        createdBy: req.user.id,
        notes: `${item.reason} (${item.reasonEn})`,
        createdAt: new Date(),
      }));
      await InventoryHistory.insertMany(historyEntries, { session });

      await session.commitTransaction();

      const populatedReturn = await Return.findById(newReturn._id)
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('orders', 'orderNumber')
        .populate('createdBy', 'name nameEn username')
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: {
          ...populatedReturn.branch,
          displayName: isRtl ? (populatedReturn.branch?.name || 'غير معروف') : (populatedReturn.branch?.nameEn || populatedReturn.branch?.name || 'Unknown'),
        },
        items: populatedReturn.items.map(item => ({
          ...item,
          product: {
            ...item.product,
            displayName: isRtl ? (item.product?.name || 'غير معروف') : (item.product?.nameEn || item.product?.name || 'Unknown'),
            displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
            department: item.product?.department ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
            } : null,
          },
          reasonDisplay: isRtl ? item.reason : item.reasonEn,
        })),
        createdByDisplay: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'Unknown'),
      };

      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id').lean();

      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'returnCreated',
          isRtl ? `طلب إرجاع جديد ${returnNumber} من ${formattedReturn.branch.displayName}` : `New return request ${returnNumber} from ${formattedReturn.branch.displayName}`,
          { returnId: newReturn._id, branchId, eventId: `${newReturn._id}-returnCreated` },
          io,
          true
        );
      }

      console.log(`[${new Date().toISOString()}] إنشاء مرتجع - تم بنجاح:`, {
        returnId: newReturn._id,
        returnNumber,
        branchId,
        userId: req.user.id,
        itemCount: items.length,
      });

      res.status(201).json({ success: true, returnRequest: formattedReturn });
      return;
    } catch (err) {
      await session.abortTransaction();
      if (err.message.includes('conflict at \'currentStock\'')) {
        retryCount++;
        console.warn(`[${new Date().toISOString()}] Conflict detected, retrying (${retryCount}/${maxRetries}):`, err.message);
        if (retryCount > maxRetries) {
          console.error(`[${new Date().toISOString()}] Max retries reached for createReturn:`, err);
          res.status(409).json({
            success: false,
            message: isRtl ? 'تضارب في تحديث المخزون، حاول مرة أخرى لاحقًا' : 'Conflict in updating inventory stock, try again later',
            error: err.message,
          });
          return;
        }
        continue;
      }
      console.error(`[${new Date().toISOString()}] خطأ في إنشاء المرتجع:`, {
        error: err.message,
        stack: err.stack,
        requestBody: req.body,
      });
      let status = 500;
      let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
      if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
      else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) status = 422;
      else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
      else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
      else if (err.name === 'ValidationError') {
        status = 400;
        message = isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error';
      }
      res.status(status).json({ success: false, message, error: err.message });
      return;
    } finally {
      session.endSession();
    }
  }
};

const getAll = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const { status, branch, search, sort = '-createdAt', page = 1, limit = 10 } = req.query;

  try {
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (branch) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    if (req.user.role === 'branch' && req.user.branchId) {
      query.branch = req.user.branchId;
    }

    if (search) {
      const products = await Product.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { nameEn: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
        ],
      }).select('_id');
      const productIds = products.map(p => p._id);
      query['items.product'] = { $in: productIds };
    }

    const total = await Return.countDocuments(query);
    const returns = await Return.find(query)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('orders', 'orderNumber')
      .populate('createdBy reviewedBy', 'name nameEn username')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const formattedReturns = returns.map(returnRequest => ({
      ...returnRequest,
      branch: returnRequest.branch
        ? {
            ...returnRequest.branch,
            displayName: isRtl ? (returnRequest.branch.name || 'غير معروف') : (returnRequest.branch.nameEn || returnRequest.branch.name || 'Unknown'),
          }
        : null,
      items: returnRequest.items.map(item => ({
        ...item,
        product: item.product
          ? {
              ...item.product,
              displayName: isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown'),
              displayUnit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
              department: item.product.department
                ? {
                    ...item.product.department,
                    displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
                  }
                : null,
            }
          : null,
        reasonDisplay: isRtl ? item.reason : item.reasonEn,
      })),
      createdByDisplay: returnRequest.createdBy
        ? isRtl
          ? (returnRequest.createdBy.name || 'غير معروف')
          : (returnRequest.createdBy.nameEn || returnRequest.createdBy.name || 'Unknown')
        : 'Unknown',
      reviewedByDisplay: returnRequest.reviewedBy
        ? isRtl
          ? (returnRequest.reviewedBy.name || 'غير معروف')
          : (returnRequest.reviewedBy.nameEn || returnRequest.reviewedBy.name || 'Unknown')
        : null,
    }));

    res.status(200).json({
      success: true,
      returns: formattedReturns,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع المرتجعات:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

const getById = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
    }

    const returnRequest = await Return.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('orders', 'orderNumber')
      .populate('createdBy reviewedBy', 'name nameEn username')
      .lean();

    if (!returnRequest) {
      return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
    }

    if (req.user.role === 'branch' && req.user.branchId?.toString() !== returnRequest.branch?.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الإرجاع' : 'Not authorized for this return' });
    }

    const formattedReturn = {
      ...returnRequest,
      branch: returnRequest.branch
        ? {
            ...returnRequest.branch,
            displayName: isRtl ? (returnRequest.branch.name || 'غير معروف') : (returnRequest.branch.nameEn || returnRequest.branch.name || 'Unknown'),
          }
        : null,
      items: returnRequest.items.map(item => ({
        ...item,
        product: item.product
          ? {
              ...item.product,
              displayName: isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown'),
              displayUnit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
              department: item.product.department
                ? {
                    ...item.product.department,
                    displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
                  }
                : null,
            }
          : null,
        reasonDisplay: isRtl ? item.reason : item.reasonEn,
      })),
      createdByDisplay: returnRequest.createdBy
        ? isRtl
          ? (returnRequest.createdBy.name || 'غير معروف')
          : (returnRequest.createdBy.nameEn || returnRequest.createdBy.name || 'Unknown')
        : 'Unknown',
      reviewedByDisplay: returnRequest.reviewedBy
        ? isRtl
          ? (returnRequest.reviewedBy.name || 'غير معروف')
          : (returnRequest.reviewedBy.nameEn || returnRequest.reviewedBy.name || 'Unknown')
        : null,
    };

    res.status(200).json({ success: true, returnRequest: formattedReturn });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع المرتجع:`, {
      error: err.message,
      stack: err.stack,
      returnId: id,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

const updateReturnStatus = async (req, res) => {
  // Alias to approveReturn for compatibility with returnsAPI.updateReturnStatus
  return approveReturn(req, res);
};

const getBranches = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';

  try {
    const query = {};
    if (req.user.role === 'branch' && req.user.branchId) {
      query._id = req.user.branchId;
    }

    const branches = await Branch.find(query).select('name nameEn').lean();
    const formattedBranches = branches.map(branch => ({
      ...branch,
      displayName: isRtl ? (branch.name || 'غير معروف') : (branch.nameEn || branch.name || 'Unknown'),
    }));

    res.status(200).json({ success: true, branches: formattedBranches });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع الفروع:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getAvailableStock = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const { branchId, productIds } = req.query;

  try {
    if (!isValidObjectId(branchId)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    const productIdArray = productIds ? productIds.split(',').filter(id => isValidObjectId(id)) : [];
    if (productIds && productIdArray.length === 0) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات غير صالحة' : 'Invalid product IDs' });
    }

    const query = { branch: branchId };
    if (productIdArray.length > 0) {
      query.product = { $in: productIdArray };
    }

    if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch' });
    }

    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .lean();

    const formattedInventory = inventories.map(item => ({
      productId: item.product?._id,
      productName: item.product ? (isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown')) : 'Unknown',
      available: item.currentStock || 0,
      unit: item.product ? (isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A')) : 'N/A',
      departmentName: item.product?.department
        ? isRtl
          ? (item.product.department.name || 'غير معروف')
          : (item.product.department.nameEn || item.product.department.name || 'Unknown')
        : 'Unknown',
      stock: item.currentStock || 0,
    }));

    res.status(200).json({ success: true, inventory: formattedInventory });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع المخزون المتاح:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

module.exports = {
  createReturn,
  getAll,
  getById,
  updateReturnStatus,
  getBranches,
  getAvailableStock,
};
