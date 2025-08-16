const Return = require('../models/Return');
const Inventory = require('../models/Inventory');

exports.processReturn = async (req, res) => {
  try {
    const { status, reviewNotes } = req.body;
    const returnDoc = await Return.findById(req.params.id);
    if (!returnDoc) return res.status(404).json({ message: 'Return not found' });

    if (status === 'approved') {
      for (const item of returnDoc.items) {
        await Inventory.findOneAndUpdate(
          { branch: returnDoc.branch, product: item.product },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'return',
                quantity: -item.quantity,
                reference: returnDoc.returnNumber,
                createdBy: req.user._id
              }
            }
          }
        );
      }
    }

    returnDoc.status = status;
    returnDoc.reviewedBy = req.user._id;
    returnDoc.reviewedAt = new Date();
    returnDoc.reviewNotes = reviewNotes;
    returnDoc.statusHistory.push({
      status,
      changedBy: req.user._id,
      notes: reviewNotes,
      changedAt: new Date()
    });

    await returnDoc.save();
    res.status(200).json(returnDoc);
  } catch (err) {
    console.error('Process return error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};