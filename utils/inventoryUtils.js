const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

// دالة لتحديث المخزون مع تسجيل الحركة في السجل
const updateInventoryStock = async ({
  branch,
  product,
  quantity,
  type,
  reference,
  referenceType,
  referenceId,
  createdBy,
  session,
  notes = '',
  isDamaged = false,
  isPending = false,
}) => {
  try {
    // التحقق من صحة المعرفات
    if (!mongoose.isValidObjectId(branch) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(createdBy)) {
      throw new Error('معرف الفرع، المنتج، أو المستخدم غير صالح');
    }

    // إعداد التحديثات للمخزون
    const update = {
      $setOnInsert: {
        product,
        branch,
        createdBy,
        minStockLevel: 0,
        maxStockLevel: 1000,
        currentStock: 0,
        damagedStock: 0,
        pendingReturnStock: 0,
      },
      $push: {
        movements: {
          type: quantity >= 0 ? 'in' : 'out',
          quantity: Math.abs(quantity),
          reference,
          createdBy,
          createdAt: new Date(),
        },
      },
    };

    // التعامل مع تحديثات المخزون بناءً على نوع العملية
    if (type === 'return_pending') {
      // عند إنشاء طلب إرجاع: تخصم الكمية من currentStock وتُضاف إلى pendingReturnStock
      update.$inc = { currentStock: quantity, pendingReturnStock: Math.abs(quantity) };
    } else if (type === 'return_approved') {
      // عند الموافقة على الإرجاع: تخصم الكمية من pendingReturnStock فقط
      update.$inc = { pendingReturnStock: -Math.abs(quantity) };
    } else if (type === 'return_rejected') {
      // عند رفض الإرجاع: تنقل الكمية من pendingReturnStock إلى damagedStock
      update.$inc = { pendingReturnStock: -Math.abs(quantity), damagedStock: Math.abs(quantity) };
    } else {
      // العمليات الأخرى: تحديث currentStock، مع إضافة إلى damagedStock إذا لزم الأمر
      update.$inc = { currentStock: quantity };
      if (isDamaged) {
        update.$inc.damagedStock = Math.abs(quantity);
      }
    }

    // تحديث المخزون أو إنشاء سجل جديد إذا لم يكن موجودًا
    const inventory = await Inventory.findOneAndUpdate(
      { branch, product },
      update,
      { upsert: true, new: true, session }
    );

    // تسجيل الحركة في سجل المخزون
    const historyEntry = new InventoryHistory({
      product,
      branch,
      action: type,
      quantity,
      reference,
      referenceType,
      referenceId,
      createdBy,
      notes,
      isDamaged,
      isPending,
    });
    await historyEntry.save({ session });

    // تسجيل نجاح العملية
    console.log(`[${new Date().toISOString()}] تحديث المخزون - تم بنجاح:`, {
      branch,
      product,
      type,
      quantity,
      reference,
    });

    return inventory;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في تحديث المخزون:`, {
      error: err.message,
      stack: err.stack,
      params: { branch, product, quantity, type },
    });
    throw new Error(err.message || 'خطأ في تحديث المخزون');
  }
};

module.exports = { updateInventoryStock };