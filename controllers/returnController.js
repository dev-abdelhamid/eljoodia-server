const mongoose = require('mongoose');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { updateInventoryStock } = require('../utils/inventoryUtils');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// دالة لتوليد رقم إرجاع فريد
const generateReturnNumber = async (branchId, session) => {
  const count = await Return.countDocuments({ branch: branchId }).session(session);
  return `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(count + 1).toString().padStart(4, '0')}`;
};

// تجميع العناصر حسب المنتج لتجنب التضارب في تحديث المخزون
const aggregateItemsByProduct = (items) => {
  const aggregated = {};
  items.forEach((item, index) => {
    if (!aggregated[item.product]) {
      aggregated[item.product] = {
        product: item.product,
        quantity: 0,
        price: item.price || 0,
        reason: item.reason,
        reasonEn: item.reasonEn,
      };
    }
    aggregated[item.product].quantity += item.quantity;
  });
  return Object.values(aggregated);
};

const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { branchId, items, notes = '', orders = [] } = req.body;

    // التحقق من المدخلات
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

    // التحقق من الفرع
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }

    // التحقق من صلاحيات المستخدم
    if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مصرح لك بإنشاء طلب إرجاع لهذا الفرع' : 'Not authorized to create a return for this branch',
      });
    }

    // التحقق من المنتجات
    const productIds = [...new Set(items.map(item => item.product))];
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found',
      });
    }

    // التحقق من المخزون
    const inventories = await Inventory.find({
      branch: branchId,
      product: { $in: productIds },
    }).session(session);
    
    const inventoryMap = {};
    inventories.forEach(inv => {
      inventoryMap[inv.product.toString()] = inv;
    });

    const errors = [];
    items.forEach((item, index) => {
      if (!isValidObjectId(item.product)) {
        errors.push({ path: `items[${index}].product`, msg: isRtl ? 'معرف المنتج غير صالح' : 'Invalid product ID' });
      }
      const inventory = inventoryMap[item.product];
      if (!inventory) {
        errors.push({ path: `items[${index}].product`, msg: isRtl ? 'المنتج غير موجود في المخزون' : 'Product not found in inventory' });
      } else if (item.quantity > inventory.currentStock) {
        errors.push({
          path: `items[${index}].quantity`,
          msg: isRtl ? `الكمية غير كافية للمنتج في المخزون: ${item.quantity} > ${inventory.currentStock}` : 
                `Insufficient quantity for product in inventory: ${item.quantity} > ${inventory.currentStock}`,
        });
      }
      if (!item.reason || !item.reasonEn) {
        errors.push({ path: `items[${index}].reason`, msg: isRtl ? 'سبب الإرجاع مطلوب' : 'Return reason is required' });
      }
    });

    if (errors.length > 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data', errors });
    }

    // تجميع العناصر حسب المنتج
    const aggregatedItems = aggregateItemsByProduct(items);

    // إنشاء طلب الإرجاع
    const returnNumber = await generateReturnNumber(branchId, session);
    const newReturn = new Return({
      branch: branchId,
      items: aggregatedItems,
      notes,
      orders,
      status: 'pending_approval',
      returnNumber,
      createdBy: req.user._id,
    });

    // تحديث المخزون
    for (const item of aggregatedItems) {
      try {
        await updateInventoryStock({
          branchId,
          productId: item.product,
          quantity: item.quantity,
          operation: 'increment',
          type: 'return_pending',
          description: isRtl ? `طلب إرجاع: ${returnNumber}` : `Return request: ${returnNumber}`,
          session,
        });
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error updating inventory for product ${item.product}:`, {
          branchId,
          quantity: item.quantity,
          error: error.message,
          stack: error.stack,
        });
        throw new Error(isRtl ? `تضارب في تحديث المخزون للمنتج ${item.product}` : `Conflict in updating inventory stock for product ${item.product}`);
      }
    }

    // حفظ طلب الإرجاع
    await newReturn.save({ session });

    // إنشاء إشعار
    await createNotification({
      userId: req.user._id,
      type: 'return_created',
      message: isRtl ? `تم إنشاء طلب إرجاع جديد: ${returnNumber}` : `New return request created: ${returnNumber}`,
      data: { returnId: newReturn._id, returnNumber },
      session,
    });

    await session.commitTransaction();

    // إرسال حدث عبر WebSocket
    if (req.io) {
      req.io.to(`branch:${branchId}`).emit('returnCreated', {
        branchId,
        returnId: newReturn._id,
        returnNumber,
        status: 'pending_approval',
        eventId: new mongoose.Types.ObjectId().toString(),
      });
    }

    return res.status(201).json({
      success: true,
      returnRequest: newReturn,
      message: isRtl ? 'تم إنشاء طلب الإرجاع بنجاح' : 'Return request created successfully',
    });
  } catch (error) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating return:`, {
      branchId: req.body.branchId,
      items: req.body.items,
      userId: req.user._id,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في إنشاء طلب الإرجاع' : 'Error creating return request',
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn };