const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },

    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1
    },

    // Full price snapshot (base, sale, saleStartDate, saleEndDate, costPrice)
    priceSnapshot: {
      base: { type: Number, required: true },
      sale: { type: Number, default: null },
      costPrice: { type: Number, default: null, select: false },
      saleStartDate: { type: Date, default: null },
      saleEndDate: { type: Date, default: null }
    },

    // Snapshot of variant attributes for display and audit
    variantAttributesSnapshot: [
      {
        key: { type: String },
        value: { type: String }
      }
    ]
  },
  { timestamps: true }
);

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },

    items: [cartItemSchema],

    totalAmount: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

//
// =======================
// AUTO RECALCULATE TOTAL
// =======================
//

// Use priceSnapshot.sale if valid else priceSnapshot.base
cartSchema.methods.calculateTotal = function () {
  const now = new Date();
  this.totalAmount = this.items.reduce((acc, item) => {
    const ps = item.priceSnapshot || {};
    const saleValid = ps.sale != null && ps.sale < ps.base &&
      (!ps.saleStartDate || now >= ps.saleStartDate) &&
      (!ps.saleEndDate || now <= ps.saleEndDate);

    const unit = saleValid ? ps.sale : ps.base || 0;
    return acc + unit * item.quantity;
  }, 0);
};

module.exports = mongoose.model("Cart", cartSchema);