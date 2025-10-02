const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const { Parser } = require('json2csv');
const logger = require('../utils/logger');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const translations = {
  ar: {
    errors: {
      invalid_branch_id: 'معرف الفرع غير صالح',
      invalid_sale_id: 'معرف البيع غير صالح',
      invalid_product_id: 'معرف المنتج غير صالح',
      invalid_quantity: 'الكمية يجب أن تكون عددًا صحيحًا إيجابيًا',
      invalid_unit_price: 'سعر الوحدة يجب أن يكون رقمًا غير سالب',
      branch_not_found: 'الفرع غير موجود',
      product_not_found: 'المنتج غير موجود',
      sale_not_found: 'البيع غير موجود',
      unauthorized: 'غير مخول للوصول إلى هذا البيع',
      insufficient_stock: 'الكمية غير كافية في المخزون للمنتج',
      validation_failed: 'خطأ في التحقق من البيانات',
      server_error: 'خطأ في السيرفر',
      sale_create_success: 'تم إنشاء البيع بنجاح',
      sale_update_success: 'تم تحديث البيع بنجاح',
      sale_delete_success: 'تم حذف البيع بنجاح',
    },
  },
  en: {
    errors: {
      invalid_branch_id: 'Invalid branch ID',
      invalid_sale_id: 'Invalid sale ID',
      invalid_product_id: 'Invalid product ID',
      invalid_quantity: 'Quantity must be a positive integer',
      invalid_unit_price: 'Unit price must be a non-negative number',
      branch_not_found: 'Branch not found',
      product_not_found: 'Product not found',
      sale_not_found: 'Sale not found',
      unauthorized: 'Unauthorized to access this sale',
      insufficient_stock: 'Insufficient stock for product',
      validation_failed: 'Validation failed',
      server_error: 'Server error',
      sale_create_success: 'Sale created successfully',
      sale_update_success: 'Sale updated successfully',
      sale_delete_success: 'Sale deleted successfully',
    },
  },
};

// Create a sale
const createSale = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const t = translations[lang] || translations.en;

  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.error('Create sale - Validation errors', { errors: errors.array(), userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: t.errors.validation_failed, errors: errors.array() });
    }

    const { items, branch, totalAmount, status = 'completed', paymentMethod = 'cash', customerName, customerPhone, notes } = req.body;
    const branchId = req.user.role === 'branch' ? req.user.branchId : branch;

    if (!isValidObjectId(branchId)) {
      logger.error('Create sale - Invalid branch ID', { branchId, userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: t.errors.invalid_branch_id });
    }

    const branchDoc = await Branch.findById(branchId).session(session);
    if (!branchDoc) {
      logger.error('Create sale - Branch not found', { branchId, userId: req.user.id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: t.errors.branch_not_found });
    }

    // Validate items
    for (const item of items) {
      if (!isValidObjectId(item.product) || item.quantity < 1 || item.unitPrice < 0) {
        logger.error('Create sale - Invalid item data', { item, userId: req.user.id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: t.errors.invalid_product_id });
      }
      const product = await Product.findById(item.product).session(session);
      if (!product) {
        logger.error('Create sale - Product not found', { productId: item.product, userId: req.user.id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: t.errors.product_not_found });
      }
      const inventory = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        logger.error('Create sale - Insufficient stock', { productId: item.product, currentStock: inventory?.currentStock, requestedQuantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: t.errors.insufficient_stock });
      }
    }

    const saleCount = await Sale.countDocuments({}).session(session);
    const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;

    const sale = new Sale({
      saleNumber,
      branch: branchId,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      totalAmount,
      status,
      paymentMethod,
      customerName: customerName?.trim(),
      customerPhone: customerPhone?.trim(),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await sale.save({ session });

    // Update inventory for completed sales
    if (status === 'completed') {
      for (const item of items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: branchId },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `Sale #${saleNumber}`,
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
          reference: `Sale #${saleNumber}`,
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

    const populatedSale = await Sale.findById(sale._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    populatedSale.branch.displayName = lang === 'ar' ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name);
    populatedSale.items = populatedSale.items.map(item => ({
      ...item,
      productName: item.product?.name || t.errors.product_not_found,
      productNameEn: item.product?.nameEn,
      displayName: lang === 'ar' ? (item.product?.name || t.errors.product_not_found) : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
      displayUnit: lang === 'ar' ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      department: item.product?.department
        ? {
            ...item.product.department,
            displayName: lang === 'ar' ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
          }
        : undefined,
    }));

    req.io?.emit('saleCreated', {
      saleId: sale._id,
      branchId,
      saleNumber,
      items,
      totalAmount,
      createdAt: sale.createdAt,
    });

    logger.info('Create sale - Success', { saleId: sale._id, branchId, itemsCount: items.length, userId: req.user.id });

    await session.commitTransaction();
    res.status(201).json({ success: true, data: populatedSale, message: t.errors.sale_create_success });
  } catch (err) {
    await session.abortTransaction();
    logger.error('Create sale - Error', { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: t.errors.server_error, error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all sales
const getSales = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const t = translations[lang] || translations.en;

  try {
    const { branch, page = 1, limit = 20, status, startDate, endDate, sort = '-createdAt' } = req.query;
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        logger.error('Get sales - Invalid branch ID', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: t.errors.invalid_branch_id });
      }
      query.branch = req.user.branchId;
    }

    if (status) query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const sales = await Sale.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort(sort)
      .lean();

    const total = await Sale.countDocuments(query);

    const transformedSales = sales.map(sale => ({
      ...sale,
      orderNumber: sale.saleNumber,
      branch: {
        ...sale.branch,
        displayName: lang === 'ar' ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
      },
      items: sale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: lang === 'ar' ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: lang === 'ar' ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: lang === 'ar' ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      })),
      createdAt: new Date(sale.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    }));

    logger.info('Get sales - Success', { count: sales.length, userId: req.user.id, query });
    res.status(200).json({ success: true, data: { sales: transformedSales, total } });
  } catch (err) {
    logger.error('Get sales - Error', { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: t.errors.server_error, error: err.message });
  }
};

// Get sale by ID
const getSaleById = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const t = translations[lang] || translations.en;

  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      logger.error('Get sale - Invalid sale ID', { id, userId: req.user.id });
      return res.status(400).json({ success: false, message: t.errors.invalid_sale_id });
    }

    const sale = await Sale.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .lean();

    if (!sale) {
      logger.error('Get sale - Sale not found', { id, userId: req.user.id });
      return res.status(404).json({ success: false, message: t.errors.sale_not_found });
    }

    if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId?.toString()) {
      logger.error('Get sale - Unauthorized', { userId: req.user.id, branchId: sale.branch._id, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: t.errors.unauthorized });
    }

    const transformedSale = {
      ...sale,
      orderNumber: sale.saleNumber,
      branch: {
        ...sale.branch,
        displayName: lang === 'ar' ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
      },
      items: sale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: lang === 'ar' ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: lang === 'ar' ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: lang === 'ar' ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      })),
      createdAt: new Date(sale.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    };

    logger.info('Get sale - Success', { saleId: id, userId: req.user.id });
    res.status(200).json({ success: true, data: transformedSale });
  } catch (err) {
    logger.error('Get sale - Error', { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: t.errors.server_error, error: err.message });
  }
};

// Update sale
const updateSale = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const t = translations[lang] || translations.en;

  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.error('Update sale - Validation errors', { errors: errors.array(), userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: t.errors.validation_failed, errors: errors.array() });
    }

    const { id } = req.params;
    const { items, totalAmount, status, paymentMethod, customerName, customerPhone, notes } = req.body;

    if (!isValidObjectId(id)) {
      logger.error('Update sale - Invalid sale ID', { id, userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: t.errors.invalid_sale_id });
    }

    const sale = await Sale.findById(id).session(session);
    if (!sale) {
      logger.error('Update sale - Sale not found', { id, userId: req.user.id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: t.errors.sale_not_found });
    }

    if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
      logger.error('Update sale - Unauthorized', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: t.errors.unauthorized });
    }

    const oldStatus = sale.status;
    sale.items = items || sale.items;
    sale.totalAmount = totalAmount || sale.totalAmount;
    sale.status = status || sale.status;
    sale.paymentMethod = paymentMethod || sale.paymentMethod;
    sale.customerName = customerName?.trim() || sale.customerName;
    sale.customerPhone = customerPhone?.trim() || sale.customerPhone;
    sale.notes = notes?.trim() || sale.notes;

    // Validate items if provided
    if (items) {
      for (const item of items) {
        if (!isValidObjectId(item.product) || item.quantity < 1 || item.unitPrice < 0) {
          logger.error('Update sale - Invalid item data', { item, userId: req.user.id });
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: t.errors.invalid_product_id });
        }
        const inventory = await Inventory.findOne({ product: item.product, branch: sale.branch }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          logger.error('Update sale - Insufficient stock', { productId: item.product, currentStock: inventory?.currentStock, requestedQuantity: item.quantity });
          await session.abortTransaction();
          return res.status(400).json({ success: false, message: t.errors.insufficient_stock });
        }
      }
    }

    await sale.save({ session });

    // Handle inventory updates
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
                reference: `Sale #${sale.saleNumber}`,
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
          reference: `Sale #${sale.saleNumber}`,
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
      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: sale.branch },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `Sale Cancelled #${sale.saleNumber}`,
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
          reference: `Sale Cancelled #${sale.saleNumber}`,
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
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    populatedSale.branch.displayName = lang === 'ar' ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name);
    populatedSale.items = populatedSale.items.map(item => ({
      ...item,
      productName: item.product?.name || t.errors.product_not_found,
      productNameEn: item.product?.nameEn,
      displayName: lang === 'ar' ? (item.product?.name || t.errors.product_not_found) : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
      displayUnit: lang === 'ar' ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      department: item.product?.department
        ? {
            ...item.product.department,
            displayName: lang === 'ar' ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
          }
        : undefined,
    }));

    req.io?.emit('saleUpdated', {
      saleId: id,
      branchId: sale.branch.toString(),
      status: sale.status,
    });

    logger.info('Update sale - Success', { saleId: id, userId: req.user.id });
    await session.commitTransaction();
    res.status(200).json({ success: true, data: populatedSale, message: t.errors.sale_update_success });
  } catch (err) {
    await session.abortTransaction();
    logger.error('Update sale - Error', { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: t.errors.server_error, error: err.message });
  } finally {
    session.endSession();
  }
};

// Delete sale
const deleteSale = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const t = translations[lang] || translations.en;

  try {
    session.startTransaction();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      logger.error('Delete sale - Invalid sale ID', { id, userId: req.user.id });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: t.errors.invalid_sale_id });
    }

    const sale = await Sale.findById(id).session(session);
    if (!sale) {
      logger.error('Delete sale - Sale not found', { id, userId: req.user.id });
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: t.errors.sale_not_found });
    }

    if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId?.toString()) {
      logger.error('Delete sale - Unauthorized', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: t.errors.unauthorized });
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
                reference: `Sale Deleted #${sale.saleNumber}`,
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
          reference: `Sale Deleted #${sale.saleNumber}`,
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

    logger.info('Delete sale - Success', { saleId: id, userId: req.user.id });
    await session.commitTransaction();
    res.status(200).json({ success: true, message: t.errors.sale_delete_success });
  } catch (err) {
    await session.abortTransaction();
    logger.error('Delete sale - Error', { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: t.errors.server_error, error: err.message });
  } finally {
    session.endSession();
  }
};

// Export sales report
const exportSalesReport = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const t = translations[lang] || translations.en;

  try {
    const { branch, startDate, endDate, format = 'csv' } = req.query;
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        logger.error('Export sales - Invalid branch ID', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: t.errors.invalid_branch_id });
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
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .lean();

    const fields = [
      { label: 'Sale Number', value: 'saleNumber' },
      { label: 'Branch', value: row => lang === 'ar' ? row.branch.name : (row.branch.nameEn || row.branch.name) },
      { label: 'Total Amount', value: 'totalAmount' },
      { label: 'Status', value: 'status' },
      { label: 'Payment Method', value: 'paymentMethod' },
      { label: 'Customer Name', value: 'customerName' },
      { label: 'Customer Phone', value: 'customerPhone' },
      { label: 'Notes', value: 'notes' },
      { label: 'Created At', value: row => new Date(row.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US') },
      { label: 'Items', value: row => row.items.map(item => `${item.product?.name || 'Deleted Product'} (${item.quantity})`).join(', ') },
    ];

    const json2csv = new Parser({ fields });
    const csv = json2csv.parse(sales);

    res.header('Content-Type', 'text/csv');
    res.attachment('sales_report.csv');
    res.send(csv);

    logger.info('Export sales - Success', { userId: req.user.id, query });
  } catch (err) {
    logger.error('Export sales - Error', { error: err.message, stack: err.stack, userId: req.user.id });
    res.status(500).json({ success: false, message: t.errors.server_error, error: err.message });
  }
};

module.exports = {
  createSale,
  getSales,
  getSaleById,
  updateSale,
  deleteSale,
  exportSalesReport,
};