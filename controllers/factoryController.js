const mongoose = require('mongoose');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryProductionRequest = require('../models/FactoryProductionRequest');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const { updateInventoryStock } = require('./inventoryStock');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);
const translateField = (item, field, lang) => lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';

const getFactoryInventory = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }

    const { product, department } = req.query;

    const query = {};
    if (product && isValidObjectId(product)) query.product = product;
    if (department && isValidObjectId(department)) query['product.department'] = department;

    const inventories = await FactoryInventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();

    const transformedInventories = inventories.map((item) => ({
      ...item,
      status: item.currentStock <= item.minStockLevel ? 'low' : item.currentStock >= item.maxStockLevel ? 'full' : 'normal',
      productName: translateField(item.product, 'name', lang),
      unit: translateField(item.product, 'unit', lang),
      departmentName: translateField(item.product?.department, 'name', lang),
    }));

    res.status(200).json({ success: true, inventory: transformedInventories });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب مخزون المصنع:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const createFactoryProductionRequest = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }

    const { type, branchId, items, notes } = req.body;

    if (!['branch', 'production'].includes(type)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'نوع الطلب غير صالح' : 'Invalid request type' });
    }

    if (type === 'branch' && !isValidObjectId(branchId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }

    const request = new FactoryProductionRequest({
      type,
      branchId: type === 'branch' ? branchId : null,
      items,
      createdBy: req.user.id,
      notes,
    });
    await request.save({ session });

    await session.commitTransaction();
    res.status(201).json({ success: true, request });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء طلب إنتاج:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const assignChefToRequest = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }

    const { requestId, chefId } = req.body;

    if (!isValidObjectId(requestId) || !isValidObjectId(chefId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو الشيف غير صالح' : 'Invalid request or chef ID' });
    }

    const request = await FactoryProductionRequest.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Request not found' });
    }

    if (request.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'لا يمكن تخصيص طلب غير معلق' : 'Cannot assign a non-pending request' });
    }

    request.assignedChef = chefId;
    request.status = 'assigned';
    await request.save({ session });

    await session.commitTransaction();
    res.status(200).json({ success: true, request });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تخصيص الشيف:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const completeProductionRequest = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }

    const { requestId } = req.params;

    if (!isValidObjectId(requestId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid request ID' });
    }

    const request = await FactoryProductionRequest.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Request not found' });
    }

    if (request.status !== 'in_progress') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب قيد التنفيذ' : 'Request must be in progress' });
    }

    request.status = 'completed';
    await request.save({ session });

    // تحديث المخزون بناءً على المنتجات المكتملة
    for (const item of request.items) {
      await updateInventoryStock({
        product: item.productId,
        quantity: item.quantity,
        type: 'production',
        reference: `إنتاج طلب #${requestId}`,
        referenceType: 'production',
        referenceId: requestId,
        createdBy: req.user.id,
        session,
      });
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, request });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إكمال طلب الإنتاج:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getFactoryProductionRequests = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }

    const { type, status } = req.query;

    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;

    const requests = await FactoryProductionRequest.find(query)
      .populate({
        path: 'branchId',
        select: 'name nameEn',
      })
      .populate({
        path: 'items.productId',
        select: 'name nameEn',
      })
      .populate('createdBy', 'username name nameEn')
      .populate('assignedChef', 'username name nameEn')
      .lean();

    const transformedRequests = requests.map((req) => ({
      ...req,
      branchName: req.branchId ? (isRtl ? req.branchId.name : req.branchId.nameEn || req.branchId.name) : 'مصنع',
      items: req.items.map(item => ({
        productName: isRtl ? item.productId.name : item.productId.nameEn || item.productId.name,
        quantity: item.quantity,
      })),
    }));

    res.status(200).json({ success: true, requests: transformedRequests });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب طلبات الإنتاج:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getFactoryInventoryHistory = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }

    const { productId, period, groupBy } = req.query;

    const query = {};
    if (productId && isValidObjectId(productId)) query.product = productId;
    if (period) {
      const now = new Date();
      let startDate;
      if (period === 'daily') startDate = new Date(now.setHours(0, 0, 0, 0));
      else if (period === 'weekly') {
        startDate = new Date(now.setDate(now.getDate() - 7));
        startDate.setHours(0, 0, 0, 0);
      } else if (period === 'monthly') startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      query.createdAt = { $gte: startDate };
    }

    let history;
    if (groupBy) {
      let groupStage;
      if (groupBy === 'day') groupStage = { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, totalQuantity: { $sum: '$quantity' } } };
      else if (groupBy === 'week') groupStage = { $group: { _id: { $week: '$createdAt' }, totalQuantity: { $sum: '$quantity' } } };
      else if (groupBy === 'month') groupStage = { $group: { _id: { $month: '$createdAt' }, totalQuantity: { $sum: '$quantity' } } };
      history = await FactoryInventory.aggregate([{ $match: query }, groupStage, { $sort: { _id: -1 } }]);
    } else {
      history = await FactoryInventory.find(query).lean();
    }

    res.status(200).json({ success: true, history });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب تاريخ مخزون المصنع:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  getFactoryInventory,
  createFactoryProductionRequest,
  assignChefToRequest,
  completeProductionRequest,
  getFactoryProductionRequests,
  getFactoryInventoryHistory,
};