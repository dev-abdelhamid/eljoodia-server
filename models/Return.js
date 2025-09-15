const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const returnSchema = new Schema(
  {
    returnNumber: {
      type: String,
      required: true,
      unique: true,
    },
    order: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    items: [
      {
        itemId: {
          type: Schema.Types.ObjectId,
          required: true,
        },
        product: {
          type: Schema.Types.ObjectId,
          ref: 'Product',
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: 1,
        },
        reason: {
          type: String,
          required: true,
          trim: true,
        },
        status: {
          type: String,
          enum: ['pending', 'approved', 'rejected'],
          default: 'pending',
        },
        reviewNotes: {
          type: String,
          trim: true,
        },
      },
    ],
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: {
      type: Date,
    },
    reviewNotes: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    statusHistory: [
      {
        status: {
          type: String,
          enum: ['pending', 'approved', 'rejected'],
          required: true,
        },
        changedBy: {
          type: Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        notes: {
          type: String,
          trim: true,
        },
        changedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Return', returnSchema);