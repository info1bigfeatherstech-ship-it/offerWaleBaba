// controllers/orderController.js
const Order = require('../models/Order');
const Address = require('../models/Address');
const Cart = require('../models/cart');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ShiprocketService = require('../utils/shiprocket');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ========== HELPERS ==========

// Helper: Calculate tax (18% GST)
const calculateTax = (amount) => {
    return amount * 0.18;
};

// Helper: Find variant in product
const findVariant = (product, variantId) => {
    if (!product || !product.variants) return null;
    return product.variants.find(v => String(v._id) === String(variantId));
};

// Helper: Check delivery availability
const checkDeliveryAvailability = async (pincode, weight = 1) => {
    const result = await ShiprocketService.getDeliveryCharges(pincode, weight);
    return result.isDeliverable;
};

// Helper: Get user-specific price from variant with sale validity check
const getUserSpecificPrice = (variant, userType) => {
    const now = new Date();
    
    if (userType === 'wholesaler') {
        const wholesaleBase = variant.price?.wholesaleBase || variant.price?.base || 0;
        let wholesaleSale = variant.price?.wholesaleSale || variant.price?.wholesaleBase || wholesaleBase;
        
        // Check if wholesale sale is valid
        const isWholesaleSaleValid = wholesaleSale !== wholesaleBase && 
            (!variant.price?.wholesaleSaleStartDate || now >= variant.price.wholesaleSaleStartDate) &&
            (!variant.price?.wholesaleSaleEndDate || now <= variant.price.wholesaleSaleEndDate);
        
        return {
            base: wholesaleBase,
            sale: isWholesaleSaleValid ? wholesaleSale : wholesaleBase,
            moq: variant.minimumOrderQuantity || 1
        };
    }
    
    // Normal user pricing
    const base = variant.price?.base || 0;
    let sale = variant.price?.sale || null;
    
    // Check if sale is valid
    const isSaleValid = sale && sale < base &&
        (!variant.price?.saleStartDate || now >= variant.price.saleStartDate) &&
        (!variant.price?.saleEndDate || now <= variant.price.saleEndDate);
    
    return {
        base: base,
        sale: isSaleValid ? sale : base,
        moq: 1
    };
};



// ========== MAIN ORDER CREATION API ==========
exports.createOrder = async (req, res) => {
    
    console.log("Create order request recieved");
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { addressId, paymentMethod, userType = 'normal', couponCode } = req.body;
        const userId = req.userId;
        const finalUserType = userType === 'wholesaler' ? 'wholesaler' : 'normal';

        // 1. Validate address
        const address = await Address.findById(addressId).session(session);
        if (!address) {
            await session.abortTransaction();
            return res.status(404).json({
                success: false,
                message: 'Address not found'
            });
        }

        // 2. Get user's cart
        const cart = await Cart.findOne({ userId }).session(session);
        if (!cart || !cart.items || cart.items.length === 0) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: 'Cart is empty'
            });
        }

        // 3. Calculate prices and validate stock
        let orderItems = [];
        let subtotal = 0;
        let totalWeight = 0;

        for (const cartItem of cart.items) {
            const product = await Product.findById(cartItem.productId).session(session);
            if (!product) {
                await session.abortTransaction();
                return res.status(404).json({
                    success: false,
                    message: `Product not found`
                });
            }

            const variant = findVariant(product, cartItem.variantId);
            if (!variant) {
                await session.abortTransaction();
                return res.status(404).json({
                    success: false,
                    message: `Variant not found for product`
                });
            }

            // Check stock
            if (variant.inventory?.trackInventory) {
                if (variant.inventory.quantity < cartItem.quantity) {
                    await session.abortTransaction();
                    return res.status(400).json({
                        success: false,
                        message: `${product.name} has only ${variant.inventory.quantity} items in stock`
                    });
                }
            }

            // Get user-specific pricing
            const price = getUserSpecificPrice(variant, finalUserType);
            
            // Check MOQ for wholesaler
            if (finalUserType === 'wholesaler') {
                if (cartItem.quantity < price.moq) {
                    await session.abortTransaction();
                    return res.status(400).json({
                        success: false,
                        message: `Minimum order quantity for ${product.name} is ${price.moq}`
                    });
                }
            }

            const itemTotal = price.sale * cartItem.quantity;
            subtotal += itemTotal;
            totalWeight += cartItem.quantity * (product.shipping?.weight || 0.5);

            orderItems.push({
                productId: product._id,
                variantId: variant._id,
                quantity: cartItem.quantity,
                priceSnapshot: {
                    base: price.base,
                    sale: price.sale,
                    total: itemTotal
                },
                variantAttributesSnapshot: cartItem.variantAttributesSnapshot || [],
                userType: finalUserType
            });

            // Deduct stock immediately (for inventory locking)
            if (variant.inventory?.trackInventory) {
                await Product.updateOne(
                    { _id: product._id, 'variants._id': variant._id },
                    { $inc: { 'variants.$.inventory.quantity': -cartItem.quantity } }
                ).session(session);
            }
        }

        // 4. Check delivery availability
        const isServiceable = await checkDeliveryAvailability(address.postalCode, totalWeight || 1);
        if (!isServiceable) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: `Delivery not available at pincode ${address.postalCode}`
            });
        }

        // 5. Get delivery charges
        const deliveryInfo = await ShiprocketService.getDeliveryCharges(address.postalCode, totalWeight || 1);
        const deliveryCharges = deliveryInfo.deliveryCharges;

        // 6. Calculate tax
        const tax = calculateTax(subtotal);

        // ========== COUPON VALIDATION ==========
        let discount = 0;
        let appliedCouponCode = null;

        if (couponCode && couponCode.trim() !== '') {
            const coupon = await Coupon.findOne({ 
                code: couponCode.toUpperCase(), 
                isActive: true 
            }).session(session);

            if (coupon) {
                // Check if coupon is expired
                const isExpired = coupon.expiryDate && coupon.expiryDate < new Date();
                
                // Check minimum order value
                const meetsMinOrder = !coupon.minOrderValue || subtotal >= coupon.minOrderValue;
                
                // Check user eligibility
                const isUserEligible = coupon.applicableUsers.includes(finalUserType);
                
                // Check usage limit
                const hasUsageLeft = !coupon.usageLimit || coupon.usedCount < coupon.usageLimit;

                if (!isExpired && meetsMinOrder && isUserEligible && hasUsageLeft) {
                    // Calculate discount
                    if (coupon.discountType === 'percentage') {
                        discount = (subtotal * coupon.discountValue) / 100;
                        if (coupon.maxDiscountAmount && discount > coupon.maxDiscountAmount) {
                            discount = coupon.maxDiscountAmount;
                        }
                    } else {
                        discount = coupon.discountValue;
                    }
                    
                    discount = Math.min(discount, subtotal);
                    appliedCouponCode = coupon.code;
                    
                    // ✅ INCREMENT COUPON USAGE COUNT
                    await Coupon.updateOne(
                        { _id: coupon._id },
                        { $inc: { usedCount: 1 } }
                    ).session(session);
                }
            }
        }

        // 7. Calculate total with discount
        const totalAmount = subtotal + deliveryCharges + tax - discount;

        // 8. Generate order ID
        const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

        // 9. Create order with discount
        const order = new Order({
            orderId: orderId,
            userId: userId,
            items: orderItems,
            subtotal: subtotal,
            deliveryCharges: deliveryCharges,
            tax: tax,
            discount: discount,
            totalAmount: totalAmount,
            address: addressId,
            addressSnapshot: address.toObject(),
            userType: finalUserType,
            orderStatus: paymentMethod === 'cod' ? 'confirmed' : 'pending',
            paymentStatus: paymentMethod === 'cod' ? 'pending' : 'pending',
            paymentInfo: {
                method: paymentMethod,
                status: 'initiated'
            }
            // ✅ appliedCoupon field - Add this to Order model first
        });

        await order.save({ session });

        // 10. Clear cart
        cart.items = [];
        cart.totalAmount = 0;
        await cart.save({ session });

        await session.commitTransaction();
        session.endSession();

        // 11. If online payment, create Razorpay order
        let razorpayOrder = null;
        if (paymentMethod === 'online') {
            try {
                razorpayOrder = await razorpay.orders.create({
                    amount: Math.round(totalAmount * 100),
                    currency: 'INR',
                    receipt: orderId,
                    payment_capture: 1,
                    notes: {
                        orderId: orderId,
                        userId: userId.toString()
                    }
                });

                order.paymentInfo.razorpayOrderId = razorpayOrder.id;
                await order.save();
            } catch (razorpayError) {
                console.error('Razorpay order creation failed:', razorpayError);
                return res.status(201).json({
                    success: true,
                    message: 'Order created but payment initiation failed. Please try again.',
                    order: {
                        orderId: order.orderId,
                        totalAmount: order.totalAmount,
                        subtotal: order.subtotal,
                        deliveryCharges: order.deliveryCharges,
                        tax: order.tax
                    },
                    razorpayError: true
                });
            }
        }
console.log("Order created", order.orderId);
        return res.status(201).json({
            success: true,
            message: paymentMethod === 'cod' ? 'Order placed successfully' : 'Order created. Complete payment to confirm.',
            order: {
                orderId: order.orderId,
                totalAmount: order.totalAmount,
                subtotal: order.subtotal,
                deliveryCharges: order.deliveryCharges,
                tax: order.tax,
                discount: discount,
                orderStatus: order.orderStatus,
                paymentStatus: order.paymentStatus
            },
            appliedCoupon: appliedCouponCode,
            razorpayOrder: razorpayOrder ? {
                id: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency
            } : null,
            paymentMethod: paymentMethod
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Create order error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error creating order',
            error: error.message
        });
    }
};

// ========== VERIFY PAYMENT ==========
exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

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

        const order = await Order.findOne({ orderId: orderId });
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        order.paymentStatus = 'paid';
        order.orderStatus = 'confirmed';
        order.paymentInfo.razorpayPaymentId = razorpay_payment_id;
        order.paymentInfo.razorpaySignature = razorpay_signature;
        order.paymentInfo.status = 'success';
        order.paymentInfo.paidAt = new Date();
        await order.save();

        // Trigger shipment creation
        ShiprocketService.createShipment(order).catch(err => {
            console.error('Shipment creation failed:', err);
        });

        return res.json({
            success: true,
            message: 'Payment verified successfully',
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus,
                paymentStatus: order.paymentStatus
            }
        });

    } catch (error) {
        console.error('Payment verification error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error verifying payment',
            error: error.message
        });
    }
};

// ========== RAZORPAY WEBHOOK ==========
exports.razorpayWebhook = async (req, res) => {
    try {
        const webhookBody = req.body;
        const webhookSignature = req.headers['x-razorpay-signature'];

        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
            .update(JSON.stringify(webhookBody))
            .digest('hex');

        if (expectedSignature !== webhookSignature) {
            return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
        }

        const { event, payload } = webhookBody;

        switch (event) {
            case 'payment.captured':
                const payment = payload.payment.entity;
                const order = await Order.findOne({ 'paymentInfo.razorpayOrderId': payment.order_id });
                if (order && order.paymentStatus !== 'paid') {
                    order.paymentStatus = 'paid';
                    order.orderStatus = 'confirmed';
                    order.paymentInfo.razorpayPaymentId = payment.id;
                    order.paymentInfo.status = 'success';
                    order.paymentInfo.paidAt = new Date();
                    await order.save();
                    
                    ShiprocketService.createShipment(order).catch(err => {
                        console.error('Shipment creation failed:', err);
                    });
                }
                break;

            case 'payment.failed':
                const failedPayment = payload.payment.entity;
                const failedOrder = await Order.findOne({ 'paymentInfo.razorpayOrderId': failedPayment.order_id });
                if (failedOrder) {
                    failedOrder.paymentStatus = 'failed';
                    failedOrder.orderStatus = 'payment_failed';
                    failedOrder.paymentInfo.status = 'failed';
                    failedOrder.paymentInfo.failureReason = failedPayment.error_description;
                    await failedOrder.save();
                    
                    for (const item of failedOrder.items) {
                        await Product.updateOne(
                            { _id: item.productId, 'variants._id': item.variantId },
                            { $inc: { 'variants.$.inventory.quantity': item.quantity } }
                        );
                    }
                }
                break;

            case 'refund.created':
                const refund = payload.refund.entity;
                const refundOrder = await Order.findOne({ 'paymentInfo.razorpayPaymentId': refund.payment_id });
                if (refundOrder) {
                    refundOrder.paymentStatus = 'refunded';
                    refundOrder.returnInfo = {
                        ...refundOrder.returnInfo,
                        refundAmount: refund.amount / 100,
                        refundId: refund.id,
                        status: 'completed'
                    };
                    await refundOrder.save();
                }
                break;
        }

        return res.json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ========== GET ORDER ==========
// controllers/orderController.js

exports.getOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        
        // ✅ Populate product with variants (to get variant images)
        const order = await Order.findOne({ orderId: orderId })
            .populate('items.productId', 'name slug variants')  // ✅ variants included
            .populate('address');

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        if (order.userId.toString() !== req.userId && req.userType !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        // ✅ Transform items to include correct variant images
        const transformedOrder = order.toObject();
        transformedOrder.items = transformedOrder.items.map(item => {
            const product = item.productId;
            const variant = product?.variants?.find(v => String(v._id) === String(item.variantId));
            
            return {
                ...item,
                productId: {
                    _id: product?._id,
                    name: product?.name,
                    slug: product?.slug,
                    // ✅ Images from variant, not product level
                    images: variant?.images || []
                }
            };
        });

        return res.json({
            success: true,
            order: transformedOrder
        });

    } catch (error) {
        console.error('Get order error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching order',
            error: error.message
        });
    }
};
// ========== GET USER ORDERS ==========
exports.getUserOrders = async (req, res) => {
    try {
        const orders = await Order.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .select('orderId totalAmount orderStatus paymentStatus createdAt deliveryCharges tax subtotal');

        return res.json({
            success: true,
            count: orders.length,
            orders: orders
        });

    } catch (error) {
        console.error('Get user orders error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching orders',
            error: error.message
        });
    }
};

// ========== CANCEL ORDER ==========
exports.cancelOrder = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { orderId } = req.params;
        const userId = req.userId;

        const order = await Order.findOne({ orderId: orderId, userId: userId }).session(session);
        if (!order) {
            await session.abortTransaction();
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        const cancellableStatuses = ['pending', 'confirmed'];
        if (!cancellableStatuses.includes(order.orderStatus)) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: `Order cannot be cancelled in ${order.orderStatus} status`
            });
        }

        order.orderStatus = 'cancelled';
        await order.save({ session });

        if (order.paymentStatus === 'paid') {
            for (const item of order.items) {
                await Product.updateOne(
                    { _id: item.productId, 'variants._id': item.variantId },
                    { $inc: { 'variants.$.inventory.quantity': item.quantity } }
                ).session(session);
            }
        }

        if (order.paymentStatus === 'paid' && order.paymentInfo.razorpayPaymentId) {
            try {
                const refund = await razorpay.payments.refund(order.paymentInfo.razorpayPaymentId, {
                    amount: Math.round(order.totalAmount * 100),
                    notes: {
                        orderId: order.orderId,
                        reason: 'Order cancelled by user'
                    }
                });
                
                order.paymentStatus = 'refunded';
                order.returnInfo = {
                    refundAmount: order.totalAmount,
                    refundId: refund.id,
                    status: 'initiated',
                    requestedAt: new Date()
                };
                await order.save({ session });
            } catch (refundError) {
                console.error('Refund initiation failed:', refundError);
            }
        }

        await session.commitTransaction();
        session.endSession();

        return res.json({
            success: true,
            message: 'Order cancelled successfully',
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus,
                paymentStatus: order.paymentStatus
            }
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Cancel order error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error cancelling order',
            error: error.message
        });
    }
};

// ========== UPDATE ORDER STATUS (Admin) ==========
exports.updateOrderStatus = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body;

        if (req.userType !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Admin access required'
            });
        }

        const order = await Order.findOne({ orderId: orderId });
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        order.orderStatus = status;
        
        if (status === 'shipped') {
            order.shipmentInfo = {
                ...order.shipmentInfo,
                shippedAt: new Date()
            };
        }
        
        if (status === 'delivered') {
            order.shipmentInfo = {
                ...order.shipmentInfo,
                deliveredAt: new Date()
            };
        }

        await order.save();

        return res.json({
            success: true,
            message: 'Order status updated successfully',
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus
            }
        });

    } catch (error) {
        console.error('Update order status error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error updating order status',
            error: error.message
        });
    }
};

// ========== GENERATE INVOICE ==========
exports.generateInvoice = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ orderId: orderId })
            .populate('items.productId', 'name')
            .populate('address');

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        if (order.userId.toString() !== req.userId && req.userType !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const invoice = {
            invoiceNumber: `INV-${order.orderId}`,
            orderId: order.orderId,
            date: order.createdAt,
            customer: order.addressSnapshot,
            items: order.items.map(item => ({
                name: item.productId?.name || 'Product',
                quantity: item.quantity,
                price: item.priceSnapshot.sale || item.priceSnapshot.base,
                total: item.priceSnapshot.total
            })),
            subtotal: order.subtotal,
            deliveryCharges: order.deliveryCharges,
            tax: order.tax,
            total: order.totalAmount,
            paymentMethod: order.paymentInfo?.method,
            paymentStatus: order.paymentStatus,
            orderStatus: order.orderStatus
        };

        return res.json({
            success: true,
            invoice: invoice
        });

    } catch (error) {
        console.error('Generate invoice error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error generating invoice',
            error: error.message
        });
    }
};

// ========== TRACK ORDER ==========
exports.trackOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ orderId: orderId });

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        if (order.userId.toString() !== req.userId && req.userType !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const timeline = {
            'pending': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Pending', completed: false, timestamp: null }
            ],
            'confirmed': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Processing', completed: false, timestamp: null }
            ],
            'shipped': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt },
                { status: 'Out for Delivery', completed: false, timestamp: null }
            ],
            'out_for_delivery': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt },
                { status: 'Out for Delivery', completed: true, timestamp: order.shipmentInfo?.outForDeliveryAt },
                { status: 'Delivered', completed: false, timestamp: null }
            ],
            'delivered': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt },
                { status: 'Out for Delivery', completed: true, timestamp: order.shipmentInfo?.outForDeliveryAt },
                { status: 'Delivered', completed: true, timestamp: order.shipmentInfo?.deliveredAt }
            ],
            'cancelled': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Cancelled', completed: true, timestamp: order.updatedAt }
            ]
        };

        const tracking = {
            orderId: order.orderId,
            currentStatus: order.orderStatus,
            trackingNumber: order.shipmentInfo?.trackingNumber || null,
            courier: order.shipmentInfo?.courier || null,
            timeline: timeline[order.orderStatus] || timeline.pending,
            estimatedDelivery: order.shipmentInfo?.estimatedDelivery || null
        };

        return res.json({
            success: true,
            tracking: tracking
        });

    } catch (error) {
        console.error('Track order error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error tracking order',
            error: error.message
        });
    }
};