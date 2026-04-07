// models/Order.js
const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId },
    quantity: { type: Number, required: true, min: 1 },
    priceSnapshot: {
      base: { type: Number, required: true },
      sale: { type: Number, default: null },
      total: { type: Number, required: true }
    },
    variantAttributesSnapshot: [
      { key: String, value: String }
    ],
    userType: { type: String, enum: ['normal', 'wholesaler'], required: true },
    
    // ✅ NEW FIELDS FOR AGGREGATOR
    hsnCode: { type: String, trim: true, uppercase: true, default: null },
    taxRate: { type: Number, min: 0, default: null },
    isFragile: { type: Boolean, default: false }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    
    // Price breakdown (calculated on server)
    subtotal: { type: Number, required: true },
    deliveryCharges: { type: Number, required: true, default: 0 },
    tax: { type: Number, required: true, default: 0 },
    discount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    
    address: { type: mongoose.Schema.Types.ObjectId, ref: 'Address', required: true },
    addressSnapshot: { type: Object, required: true },
    
    userType: { type: String, enum: ['normal', 'wholesaler'], required: true },
    
    orderStatus: { 
      type: String, 
      enum: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'return_requested'], 
      default: 'pending' 
    },
    
    paymentStatus: { 
      type: String, 
      enum: ['pending', 'initiated', 'paid', 'failed', 'refunded'], 
      default: 'pending' 
    },
    
    paymentInfo: { 
      razorpayOrderId: String,
      razorpayPaymentId: String,
      razorpaySignature: String,
      amount: Number,
      method: String,
      status: String,
      paidAt: Date
    },
    
    // For shipment (future use)
    shipmentInfo: {
      trackingNumber: String,
      courier: String,
      shippedAt: Date,
      deliveredAt: Date
    },
    
    // For returns
    returnInfo: {
      requestedAt: Date,
      approvedAt: Date,
      refundAmount: Number,
      refundId: String,
      status: String
    },
    appliedCoupon: {
        code: { type: String },
        discount: { type: Number, default: 0 }
    }
  },
  { timestamps: true }
);

// Generate order ID before saving
orderSchema.pre('save', function() {
  if (!this.orderId) {
    this.orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }
});

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ orderId: 1 }, { unique: true });

module.exports = mongoose.model('Order', orderSchema);