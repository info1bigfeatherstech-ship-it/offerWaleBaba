// const mongoose = require('mongoose');

// const orderItemSchema = new mongoose.Schema(
//   {
//     productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
//     variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
//     quantity: { type: Number, required: true, min: 1 },
//     priceSnapshot: {
//       base: { type: Number, required: true },
//       sale: { type: Number, default: null },
//     },
//     variantAttributesSnapshot: [
//       { key: String, value: String }
//     ]
//   },
//   { _id: false }
// );


// const orderSchema = new mongoose.Schema(
//   {
//     userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
//     items: { type: [orderItemSchema], required: true },
//     totalAmount: { type: Number, required: true },
//     address: { type: mongoose.Schema.Types.ObjectId, ref: 'Address', required: true },
//     orderStatus: { type: String, enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
//     paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
//     paymentInfo: { type: Object, default: null }
//   },
//   { timestamps: true }
// );

// orderSchema.index({ userId: 1, createdAt: -1 });

// module.exports = mongoose.model('Order', orderSchema);



// models/Order.js
const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId }, // Make optional if not using variants
    quantity: { type: Number, required: true, min: 1 },
    priceSnapshot: {
      base: { type: Number, required: true },
      sale: { type: Number, default: null },
      total: { type: Number, required: true } // Add total price for this item
    },
    variantAttributesSnapshot: [
      { key: String, value: String }
    ],
    userType: { type: String, enum: ['normal', 'wholesaler'], required: true } // Track which price was used
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true, required: true }, // Add custom order ID
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    
    // Price breakdown (calculated on server)
    subtotal: { type: Number, required: true }, // Sum of all items
    deliveryCharges: { type: Number, required: true, default: 0 },
    tax: { type: Number, required: true, default: 0 },
    discount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true }, // subtotal + delivery + tax - discount
    
    address: { type: mongoose.Schema.Types.ObjectId, ref: 'Address', required: true },
    addressSnapshot: { type: Object, required: true }, // Store address at order time
    
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
    }
  },
  { timestamps: true }
);

// Generate order ID before saving
orderSchema.pre('save', function(next) {
  if (!this.orderId) {
    const date = new Date();
    const timestamp = date.getTime();
    const random = Math.floor(Math.random() * 10000);
    this.orderId = `ORD-${timestamp}-${random}`;
  }
  next();
});

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ orderId: 1 }, { unique: true });

module.exports = mongoose.model('Order', orderSchema);