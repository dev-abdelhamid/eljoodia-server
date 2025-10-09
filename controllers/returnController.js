const mongoose = require('mongoose');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const { updateInventoryStock } = require('../utils/inventoryUtils');
const { createNotification } = require('../utils/notifications');

// Sequence model for generating unique return numbers
const Sequence = mongoose.model('Sequence', new mongoose.Schema({
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  date: { type: String, required: true }, // Format: YYYYMMDD
  count: { type: Number, default: 0 },
}, { timestamps: true }));

// Ensure unique index on Sequence collection
Sequence.collection.createIndex({ branch: 1, date: 1 }, { unique: true });

// Helper to validate ObjectId
const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Generate unique return number with enhanced retry logic and cleanup
const generateReturnNumber = async (branchId, session, maxRetries = 5) => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // Pre-check for stale sequence with abnormally high count
      const existingSequence = await Sequence.findOne({ branch: branchId, date }).session(session);
      if (existingSequence && existingSequence.count > 9999) {
        console.warn(`[${new Date().toISOString()}] Stale sequence detected, resetting count`, {
          branchId,
          date,
          count: existingSequence.count,
        });
        await Sequence.deleteOne({ branch: branchId, date }, { session });
      }

      const sequence = await Sequence.findOneAndUpdate(
        { branch: branchId, date },
        { $inc: { count: 1 } },
        { 
          upsert: true, 
          new: true, 
          session,
          // Add timeout to prevent hanging
          maxTimeMS: 5000
        }
      );

      const returnNumber = `RET-${date}-${sequence.count.toString().padStart(4, '0')}`;
      
      // Verify uniqueness in Return collection
      const existingReturn = await Return.findOne({ returnNumber }).session(session);
      if (existingReturn) {
        console.warn(`[${new Date().toISOString()}] Duplicate returnNumber detected: ${returnNumber}`);
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 200)); // Increased delay to reduce contention
        continue;
      }
      
      return returnNumber;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Retry ${retryCount + 1} failed for returnNumber generation:`, {
        branchId,
        date,
        error: err.message,
        stack: err.stack,
      });
      if ((err.code === 11000 || err.message.includes('duplicate key')) && retryCount < maxRetries - 1) {
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 200)); // Increased delay
        continue;
      }
      throw new Error(`Failed to generate unique return number for branch ${branchId} on ${date} after ${maxRetries} retries: ${err.message}`);
    }
  }
  throw new Error(`Exhausted ${maxRetries} retries generating unique return number for branch ${branchId} on ${date}. Please check Sequence and Return collections for stale data.`);
};

// Create a new return request
const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession({ defaultTransactionOptions: { maxTimeMS: 60000 } });

  try {
    session.startTransaction();

    const { branchId, items, notes = '', orders = [] } = req.body;

    // Validate inputs
    if (!isValidObjectId(branchId)) {
      throw new Error(isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID');
    }
    if (!Array.isArray(items) || !items.length) {
      throw new Error(isRtl ? 'العناصر مطلوبة' : 'Items are required');
    }
    if (!Array.isArray(orders) || orders.some(id => !isValidObjectId(id))) {
      throw new Error(isRtl ? 'معرفات الطلبات غير صالحة' : 'Invalid order IDs');
    }

    // Validate branch
    const branch = await Branch.findById(branchId).session(session).lean();
    if (!branch) {
      throw new Error(isRtl ? 'الفرع غير موجود' : 'Branch not found');
    }

    // Validate user authorization
    if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
      throw new Error(isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch');
    }

    // Validate items
    const reasonMap = {
      'تالف': 'Damaged',
      'منتج خاطئ': 'Wrong Item',
      'كمية زائدة': 'Excess Quantity',
      'أخرى': 'Other',
    };
    const productIds = items.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    if (products.length !== productIds.length) {
      throw new Error(isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found');
    }

    // Prepare and validate return items
    const returnItems = items.map((item, index) => {
      const product = products.find(p => p._id.toString() === item.product);
      if (!product) {
        throw new Error(isRtl ? `المنتج غير موجود: ${item.product}` : `Product not found: ${item.product}`);
      }
      if (!item.quantity || item.quantity < 1) {
        throw new Error(isRtl ? `الكمية غير صالحة للعنصر ${index + 1}` : `Invalid quantity for item ${index + 1}`);
      }
      if (!reasonMap[item.reason]) {
        throw new Error(isRtl ? `سبب الإرجاع غير صالح للعنصر ${index + 1}: ${item.reason}` : `Invalid return reason for item ${index + 1}: ${item.reason}`);
      }
      if (item.reasonEn && item.reasonEn !== reasonMap[item.reason]) {
        throw new Error(isRtl ? `سبب الإرجاع بالإنجليزية غير متطابق للعنصر ${index + 1}` : `English return reason mismatch for item ${index + 1}`);
      }
      return {
        product: item.product,
        quantity: item.quantity,
        price: product.price || 0,
        reason: item.reason,
        reasonEn: reasonMap[item.reason],
      };
    });

    // Validate inventory stock
    for (const item of returnItems) {
      const inventory = await Inventory.findOne({ branch: branchId, product: item.product }).session(session).lean();
      if (!inventory) {
        throw new Error(isRtl ? `المخزون غير موجود للمنتج ${item.product}` : `Inventory not found for product ${item.product}`);
      }
      if (inventory.currentStock < item.quantity) {
        throw new Error(isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}`);
      }
    }

    // Generate unique return number
    const returnNumber = await generateReturnNumber(branchId, session);

    // Create return
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

    // Reserve stock in pendingReturnStock
    for (const item of returnItems) {
      await updateInventoryStock({
        branch: branchId,
        product: item.product,
        quantity: item.quantity,
        type: 'return_pending',
        reference: `مرتجع #${returnNumber}`,
        referenceType: 'return',
        referenceId: newReturn._id,
        createdBy: req.user.id,
        session,
        notes: `${item.reason} (${item.reasonEn})`,
        isPending: true,
      });
    }

    // Commit transaction after all operations
    await session.commitTransaction();

    // Populate response
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

    // Non-blocking notifications
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

    console.log(`[${new Date().toISOString()}] Create return - Success:`, {
      returnId: newReturn._id,
      returnNumber,
      branchId,
      userId: req.user.id,
      itemCount: items.length,
    });

    res.status(201).json({ success: true, returnRequest: formattedReturn });
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error(`[${new Date().toISOString()}] Error creating return:`, {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) {
      status = 404;
      message = err.message;
    } else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) {
      status = 422;
      message = err.message;
    } else if (err.message.includes('غير مخول') || err.message.includes('authorized')) {
      status = 403;
      message = err.message;
    } else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) {
      status = 400;
      message = err.message;
    } else if (err.name === 'ValidationError') {
      status = 400;
      message = isRtl ? `خطأ في التحقق من البيانات: ${err.message}` : `Validation error: ${err.message}`;
    } else if (err.message.includes('unique return number') || err.code === 11000) {
      status = 400;
      message = isRtl 
        ? `فشل في إنشاء رقم مرتجع فريد: ${err.message}. حاول مرة أخرى أو قم بتنظيف بيانات Sequence.`
        : `Failed to generate unique return number: ${err.message}. Try again or clean Sequence collection.`;
    } else if (err.message.includes('request aborted')) {
      status = 499;
      message = isRtl ? 'تم إلغاء الطلب من العميل' : 'Request aborted by client';
    }
    res.status(status).json({ 
      success: false, 
      message, 
      error: err.message,
      suggestion: err.message.includes('unique return number') 
        ? (isRtl 
            ? 'تحقق من مجموعتي Sequence و Return لإزالة البيانات المتكررة أو القديمة.'
            : 'Check Sequence and Return collections for duplicate or stale data.')
        : undefined
    });
  } finally {
    session.endSession();
  }
};

// Approve or reject a return request
const approveReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession({ defaultTransactionOptions: { maxTimeMS: 60000 } });

  try {
    session.startTransaction();
    const { id } = req.params;
    const { status, reviewNotes = '' } = req.body;

    // Validate inputs
    if (!isValidObjectId(id)) {
      throw new Error(isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID');
    }
    if (!['approved', 'rejected'].includes(status)) {
      throw new Error(isRtl ? 'حالة غير صالحة' : 'Invalid status');
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      throw new Error(isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Not authorized to approve return');
    }

    // Validate return
    const returnRequest = await Return.findById(id).session(session);
    if (!returnRequest) {
      throw new Error(isRtl ? 'الإرجاع غير موجود' : 'Return not found');
    }
    if (returnRequest.status !== 'pending_approval') {
      throw new Error(isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval');
    }

    // Update inventory based on status
    let adjustedTotal = 0;
    for (const item of returnRequest.items) {
      const inventory = await Inventory.findOne({ branch: returnRequest.branch, product: item.product }).session(session).lean();
      if (!inventory || inventory.pendingReturnStock < item.quantity) {
        throw new Error(isRtl ? `الكمية المحجوزة غير كافية للمنتج ${item.product}` : `Insufficient reserved quantity for product ${item.product}`);
      }
      if (status === 'approved') {
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: item.product,
          quantity: item.quantity,
          type: 'return_approved',
          reference: `Approved return #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn})`,
          isPending: false,
        });
        adjustedTotal += item.quantity * item.price;
      } else if (status === 'rejected') {
        await updateInventoryStock({
          branch: returnRequest.branch,
          product: item.product,
          quantity: item.quantity,
          type: 'return_rejected',
          reference: `Rejected return #${returnRequest.returnNumber}`,
          referenceType: 'return',
          referenceId: returnRequest._id,
          createdBy: req.user.id,
          session,
          notes: `${item.reason} (${item.reasonEn}) - Rejected by admin, moved to damaged stock`,
          isDamaged: true,
          isPending: false,
        });
      }
    }

    // Update return status
    returnRequest.status = status;
    returnRequest.reviewNotes = reviewNotes.trim();
    returnRequest.reviewedBy = req.user.id;
    returnRequest.reviewedAt = new Date();
    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: reviewNotes.trim(),
      changedAt: new Date(),
    });
    await returnRequest.save({ session });

    await session.commitTransaction();

    // Populate response
    const populatedReturn = await Return.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('orders', 'orderNumber')
      .populate('createdBy', 'name nameEn username')
      .populate('reviewedBy', 'name nameEn username')
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
      reviewedByDisplay: isRtl ? (populatedReturn.reviewedBy?.name || 'غير معروف') : (populatedReturn.reviewedBy?.nameEn || populatedReturn.reviewedBy?.name || 'Unknown'),
    };

    // Non-blocking notifications
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: returnRequest.branch },
      ],
    }).select('_id branch').lean();

    const branchName = populatedReturn.branch?.name || 'غير معروف';
    for (const user of usersToNotify) {
      await createNotification(
        user._id,
        'returnStatusUpdated',
        isRtl ? `تم تحديث حالة طلب الإرجاع ${populatedReturn.returnNumber} إلى ${status === 'approved' ? 'موافق عليه' : 'مرفوض'} بواسطة ${branchName}` : `Return request ${populatedReturn.returnNumber} updated to ${status} by ${populatedReturn.branch?.nameEn || branchName}`,
        { returnId: id, branchId: returnRequest.branch, status, eventId: `${id}-returnStatusUpdated` },
        io,
        true
      );
    }

    // Notify branch about damaged stock responsibility on rejection
    if (status === 'rejected') {
      const branchUsers = await User.find({ role: 'branch', branch: returnRequest.branch }).select('_id').lean();
      for (const user of branchUsers) {
        for (const item of returnRequest.items) {
          const product = await Product.findById(item.product).lean();
          const productName = isRtl ? (product?.name || 'غير معروف') : (product?.nameEn || product?.name || 'Unknown');
          await createNotification(
            user._id,
            'damagedStockResponsibility',
            isRtl ? `تم رفض إرجاع ${item.quantity} من ${productName}، أصبحت الكمية تالفة ومسؤولية الفرع` : `Rejected return of ${item.quantity} ${productName}, quantity is now damaged and branch responsibility`,
            { returnId: id, productId: item.product, quantity: item.quantity },
            io,
            true
          );
        }
      }
    }

    console.log(`[${new Date().toISOString()}] Approve return - Success:`, {
      returnId: id,
      returnNumber: returnRequest.returnNumber,
      status,
      userId: req.user.id,
    });

    res.status(200).json({ success: true, returnRequest: { ...formattedReturn, adjustedTotal } });
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error(`[${new Date().toISOString()}] Error approving return:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) {
      status = 404;
      message = err.message;
    } else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) {
      status = 422;
      message = err.message;
    } else if (err.message.includes('غير مخول') || err.message.includes('authorized')) {
      status = 403;
      message = err.message;
    } else if (err.message.includes('غير صالح') || err.message.includes('Invalid') || err.message.includes('pending')) {
      status = 400;
      message = err.message;
    } else if (err.name === 'ValidationError') {
      status = 400;
      message = isRtl ? `خطأ في التحقق من البيانات: ${err.message}` : `Validation error: ${err.message}`;
    } else if (err.message.includes('request aborted')) {
      status = 499;
      message = isRtl ? 'تم إلغاء الطلب من العميل' : 'Request aborted by client';
    }
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createReturn, approveReturn };
