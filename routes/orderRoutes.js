// const express = require('express');
// const router = express.Router();
// const { createOrder, getOrder, getUserOrders, updateOrderStatus } = require('../controllers/orderController');
// const {verifyToken} = require('../middlewares/auth');

// // Create a new order
// router.post('/', verifyToken, createOrder);

// // Get a specific order by ID
// router.get('/:id', verifyToken, getOrder);

// // Get all orders for a user
// router.get('/', verifyToken, getUserOrders);

// // Update order status (admin only)
// router.put('/:id/status', verifyToken, updateOrderStatus);

// module.exports = router;