// // routes/orderRoutes.js
// const express = require('express');
// const router = express.Router();
// const { verifyToken } = require('../middlewares/auth');
// const { authorizeRoles } = require('../middlewares/authorizeRoles');
// const {
//     createOrder,
//     verifyPayment,
//     razorpayWebhook,
//     getOrder,
//     getUserOrders,
//     cancelOrder,
//     updateOrderStatus,
//     generateInvoice,
//     trackOrder
// } = require('../controllers/orderController');

// // ========== PUBLIC ROUTES ==========
// // Razorpay webhook (no auth required)
// router.post('/payment/webhook', razorpayWebhook);

// // ========== USER ROUTES (Authenticated) ==========
// // Create order
// router.post('/items', verifyToken, createOrder);

// // Verify payment after Razorpay success
// router.post('/items/verify-payment', verifyToken, verifyPayment);

// // Get user's all orders
// router.get('/items', verifyToken, getUserOrders);

// // Get single order by ID
// router.get('/items/:orderId', verifyToken, getOrder);

// // Track order status
// router.get('/items/:orderId/track', verifyToken, trackOrder);

// // Generate invoice
// router.get('/items/:orderId/invoice', verifyToken, generateInvoice);

// // Cancel order
// router.put('/items/:orderId/cancel', verifyToken, cancelOrder);

// // ========== ADMIN ROUTES ==========
// // Update order status (admin or order_manager)
// router.put('/admin/items/:orderId/status', verifyToken, authorizeRoles('admin', 'order_manager'), updateOrderStatus);

// module.exports = router;