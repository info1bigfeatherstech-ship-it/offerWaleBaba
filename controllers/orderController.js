// const Order = require('../models/Order');
// const Address = require('../models/Address');

// // Create a new order
// exports.createOrder = async (req, res) => {
//     try {
//         // may add the delivery charger here in future after learning
//         const { items, totalAmount, addressId } = req.body;
//         const address = await Address.findById(addressId);
//         if (!address) return res.status(404).json({ message: 'Address not found' });

//         const order = new Order({
//             userId: req.user._id,
//             items,
//             totalAmount,
//             address: addressId
//         });
//         await order.save();
//         res.status(201).json({ message: 'Order created successfully', order });
//     } catch (error) {
//         res.status(500).json({ message: 'Error creating order', error });
//     }
// };

// // Get a specific order by ID
// exports.getOrder = async (req, res) => {
//     try {
//         const { id } = req.params;
//         const order = await Order.findById(id).populate('items.productId').populate('address');
//         if (!order) return res.status(404).json({ message: 'Order not found' });
//         res.status(200).json(order);
//     } catch (error) {
//         res.status(500).json({ message: 'Error fetching order', error });
//     }
// };

// // Get all orders for a user
// exports.getUserOrders = async (req, res) => {
//     try {
//         const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 });
//         res.status(200).json(orders);
//     } catch (error) {
//         res.status(500).json({ message: 'Error fetching orders', error });
//     }
// };
            
// // Update order status (admin only)
// exports.updateOrderStatus = async (req, res) => {
//     try {
//         const { id } = req.params;
//         const { status } = req.body;
//         const order = await Order.findByIdAndUpdate(id, { orderStatus: status }, { new: true });
//         if (!order) return res.status(404).json({ message: 'Order not found' });
//         res.status(200).json({ message: 'Order status updated successfully', order });
//     } catch (error) {
//         res.status(500).json({ message: 'Error updating order status', error });
//     }    
// };



// controllers/orderController.js
const Order = require('../models/Order');
const Address = require('../models/Address');
const Product = require('../models/Product'); // Need product model
const Cart = require('../models/Cart'); // Need cart model

// Create order from cart (NOT from frontend total)
exports.createOrder = async (req, res) => {
  try {
    const { addressId, paymentMethod, userType } = req.body;
    const userId = req.user._id;

    // 1. Validate address
    const address = await Address.findById(addressId);
    if (!address) {
      return res.status(404).json({ 
        success: false, 
        message: 'Address not found' 
      });
    }

    // 2. Get user's cart items
    const cartItems = await Cart.find({ userId }).populate('productId');
    
    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cart is empty' 
      });
    }

    // 3. Calculate prices from actual product data (NEVER from frontend)
    let orderItems = [];
    let subtotal = 0;

    for (const cartItem of cartItems) {
      const product = cartItem.productId;
      
      // Check stock
      if (product.stock < cartItem.quantity) {
        return res.status(400).json({
          success: false,
          message: `${product.name} has only ${product.stock} items in stock`
        });
      }

      let basePrice, salePrice;

      // Apply pricing based on user type
      if (userType === 'wholesaler') {
        // Check MOQ for wholesaler
        if (cartItem.quantity < product.wholesaleMoq) {
          return res.status(400).json({
            success: false,
            message: `Minimum order quantity for ${product.name} is ${product.wholesaleMoq}`
          });
        }
        basePrice = product.wholesalePrice;
        salePrice = product.wholesaleSalePrice || product.wholesalePrice;
      } else {
        // Normal user pricing
        basePrice = product.basePrice;
        salePrice = product.salePrice || product.basePrice;
      }

      const itemTotal = salePrice * cartItem.quantity;
      subtotal += itemTotal;

      orderItems.push({
        productId: product._id,
        variantId: cartItem.variantId || null,
        quantity: cartItem.quantity,
        priceSnapshot: {
          base: basePrice,
          sale: salePrice,
          total: itemTotal
        },
        variantAttributesSnapshot: cartItem.variantAttributes || [],
        userType: userType
      });
    }

    // 4. Calculate delivery charges (mock for now)
    const deliveryCharges = calculateDeliveryCharges(address.postalCode);
    
    // 5. Calculate tax (e.g., 18% GST)
    const tax = subtotal * 0.18;
    
    // 6. Calculate total
    const totalAmount = subtotal + deliveryCharges + tax;

    // 7. Create order with calculated prices
    const order = new Order({
      userId: userId,
      items: orderItems,
      subtotal: subtotal,
      deliveryCharges: deliveryCharges,
      tax: tax,
      discount: 0,
      totalAmount: totalAmount,
      address: addressId,
      addressSnapshot: address.toObject(), // Store snapshot of address
      userType: userType,
      orderStatus: 'pending',
      paymentStatus: 'pending'
    });

    await order.save();

    // 8. If online payment, create Razorpay order
    let razorpayOrder = null;
    if (paymentMethod === 'online') {
      razorpayOrder = await createRazorpayOrder(order);
      
      // Update order with Razorpay order ID
      order.paymentInfo = {
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        status: 'created'
      };
      await order.save();
    }

    // 9. Return response
    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      order: {
        orderId: order.orderId,
        totalAmount: order.totalAmount,
        subtotal: order.subtotal,
        deliveryCharges: order.deliveryCharges,
        tax: order.tax
      },
      razorpayOrder: razorpayOrder, // Send to frontend for payment
      paymentMethod: paymentMethod
    });

  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error creating order', 
      error: error.message 
    });
  }
};

// Helper: Calculate delivery charges
function calculateDeliveryCharges(pincode) {
  const freeDeliveryPincodes = ['560001', '400001', '110001'];
  if (freeDeliveryPincodes.includes(pincode)) {
    return 0;
  }
  return 50; // Default ₹50 delivery charge
}

// Helper: Create Razorpay order
async function createRazorpayOrder(order) {
  const Razorpay = require('razorpay');
  
  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  const options = {
    amount: Math.round(order.totalAmount * 100), // Convert to paise
    currency: 'INR',
    receipt: order.orderId,
    payment_capture: 1 // Auto capture
  };

  try {
    const razorpayOrder = await razorpay.orders.create(options);
    return razorpayOrder;
  } catch (error) {
    console.error('Razorpay order creation error:', error);
    throw new Error('Failed to create payment order');
  }
}

// Verify payment and update order
exports.verifyPayment = async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature,
      orderId 
    } = req.body;

    // Verify signature
    const crypto = require('crypto');
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }

    // Update order
    const order = await Order.findOneAndUpdate(
      { orderId: orderId },
      {
        paymentStatus: 'paid',
        orderStatus: 'confirmed',
        'paymentInfo.razorpayPaymentId': razorpay_payment_id,
        'paymentInfo.razorpaySignature': razorpay_signature,
        'paymentInfo.status': 'success',
        'paymentInfo.paidAt': new Date()
      },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Clear user's cart
    await Cart.deleteMany({ userId: order.userId });

    // Update inventory
    for (const item of order.items) {
      await Product.findByIdAndUpdate(
        item.productId,
        { $inc: { stock: -item.quantity } }
      );
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      order: order
    });

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying payment',
      error: error.message
    });
  }
};

// Get order by orderId
exports.getOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findOne({ orderId: orderId })
      .populate('items.productId')
      .populate('address');

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found' 
      });
    }

    // Check if user owns this order or is admin
    if (order.userId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: 'Unauthorized' 
      });
    }

    res.status(200).json({
      success: true,
      order: order
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching order', 
      error: error.message 
    });
  }
};

// Get all orders for a user
exports.getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .select('orderId totalAmount orderStatus paymentStatus createdAt'); // Select only needed fields

    res.status(200).json({
      success: true,
      count: orders.length,
      orders: orders
    });
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching orders', 
      error: error.message 
    });
  }
};

// Update order status (admin only)
exports.updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const order = await Order.findOneAndUpdate(
      { orderId: orderId },
      { orderStatus: status },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found' 
      });
    }

    res.status(200).json({
      success: true,
      message: 'Order status updated successfully',
      order: order
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating order status', 
      error: error.message 
    });
  }
};

// Cancel order (user)
exports.cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ 
      orderId: orderId, 
      userId: req.user._id 
    });

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found' 
      });
    }

    // Check if order can be cancelled
    const cancellableStatuses = ['pending', 'confirmed'];
    if (!cancellableStatuses.includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `Order cannot be cancelled in ${order.orderStatus} status`
      });
    }

    order.orderStatus = 'cancelled';
    await order.save();

    // Restore inventory if payment was made
    if (order.paymentStatus === 'paid') {
      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.productId,
          { $inc: { stock: item.quantity } }
        );
      }
    }

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      order: order
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelling order',
      error: error.message
    });
  }
};