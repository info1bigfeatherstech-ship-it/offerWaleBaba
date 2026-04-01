// routes/orderRoutes.js
const express = require('express');
const router = express.Router();
const {verifyToken} = require('../middlewares/auth');
const {
    createOrder,
    verifyPayment,
    razorpayWebhook,
    getOrder,
    getUserOrders,
    cancelOrder,
    updateOrderStatus,
    generateInvoice,
    trackOrder
} = require('../controllers/orderController');

// Public webhook (no auth)
router.post('/payment/webhook', razorpayWebhook);

// Protected routes
router.post('/orders', verifyToken, createOrder);
router.post('/orders/verify-payment', verifyToken, verifyPayment);
router.get('/orders', verifyToken, getUserOrders);
router.get('/orders/:orderId', verifyToken, getOrder);
router.get('/orders/:orderId/track', verifyToken, trackOrder);
router.get('/orders/:orderId/invoice', verifyToken, generateInvoice);
router.put('/orders/:orderId/cancel', verifyToken, cancelOrder);

// Admin only
router.put('/admin/orders/:orderId/status', verifyToken, updateOrderStatus);

module.exports = router;