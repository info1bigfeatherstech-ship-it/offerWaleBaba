const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  createOrder,
  verifyPayment,
  payOrderBalance,
  getOrder,
  getUserOrders,
  cancelOrder,
  updateOrderStatus,
  generateInvoice,
  trackOrder,
  refundOrderPayment
} = require('../controllers/order.controller');

// Razorpay webhook is mounted in index.js (raw body) — not here

router.post('/items', verifyToken, createOrder);
router.post('/items/verify-payment', verifyToken, verifyPayment);
router.post('/items/:orderId/pay-balance', verifyToken, payOrderBalance);
router.get('/items', verifyToken, getUserOrders);
router.get('/items/:orderId', verifyToken, getOrder);
router.get('/items/:orderId/track', verifyToken, trackOrder);
router.get('/items/:orderId/invoice', verifyToken, generateInvoice);
router.put('/items/:orderId/cancel', verifyToken, cancelOrder);

router.post(
  '/admin/items/:orderId/refund',
  verifyToken,
  authorizeRoles('admin'),
  refundOrderPayment
);

router.put(
  '/admin/items/:orderId/status',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  updateOrderStatus
);

module.exports = router;
