const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    quantity: { type: Number, required: true, min: 1 },
    priceSnapshot: {
      base: { type: Number, required: true },
      sale: { type: Number, default: null },
      costPrice: { type: Number, default: null, select: false },
      saleStartDate: { type: Date, default: null },
      saleEndDate: { type: Date, default: null }
    },
    variantAttributesSnapshot: [
      { key: String, value: String }
    ]
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    totalAmount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'paid', 'processing', 'completed', 'cancelled', 'failed'], default: 'pending' },
    paymentInfo: { type: Object, default: null }
  },
  { timestamps: true }
);

orderSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
