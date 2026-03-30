const Razorpay = require('razorpay');
const crypto = require('crypto');
const Order = require('../models/Order');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Create a Razorpay payment order
exports.createPaymentOrder = async (req, res) => {
    try {
        const { amount, currency, receipt } = req.body;
        const options = {
            amount: amount * 100, // Amount in smallest currency unit (e.g., paise for INR)
            currency,
            receipt
        };
        const order = await razorpay.orders.create(options);
        res.status(201).json(order);
    } catch (error) {
        res.status(500).json({ message: 'Error creating payment order', error });
    }
};

// Verify Razorpay payment
exports.verifyPayment = async (req, res) => {
    try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
        const generatedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpayOrderId + '|' + razorpayPaymentId)
            .digest('hex');

        if (generatedSignature !== razorpaySignature) {
            return res.status(400).json({ message: 'Invalid payment signature' });
        }

        const order = await Order.findOneAndUpdate(
            { _id: razorpayOrderId },
            { paymentStatus: 'paid', orderStatus: 'confirmed' },
            { new: true }
        );

        if (!order) return res.status(404).json({ message: 'Order not found' });

        res.status(200).json({ message: 'Payment verified successfully', order });
    } catch (error) {
        res.status(500).json({ message: 'Error verifying payment', error });
    }
};

// Handle payment failure
exports.handlePaymentFailure = async (req, res) => {
    try {
        const { orderId } = req.body;
        const order = await Order.findByIdAndUpdate(orderId, { paymentStatus: 'failed', orderStatus: 'cancelled' }, { new: true });
        if (!order) return res.status(404).json({ message: 'Order not found' });

        res.status(200).json({ message: 'Payment marked as failed', order });
    } catch (error) {
        res.status(500).json({ message: 'Error handling payment failure', error });
    }
};

// Process refund
exports.processRefund = async (req, res) => {
    try {
        const { paymentId, amount } = req.body;
        const refund = await razorpay.payments.refund(paymentId, { amount: amount * 100 });
        res.status(200).json({ message: 'Refund processed successfully', refund });
    } catch (error) {
        res.status(500).json({ message: 'Error processing refund', error });
    }
};



// // /* NODE SDK: https://github.com/razorpay/razorpay-node */
// const {validateWebhookSignature} = require('razorpay/dist/utils/razorpay-utils')

// validateWebhookSignature(JSON.stringify(webhookBody), webhookSignature, webhookSecret)
// #webhook_body should be raw webhook request body