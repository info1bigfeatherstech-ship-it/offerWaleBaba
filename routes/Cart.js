// routes/cartRoutes.js
const express = require('express');
const router = express.Router();

const {
  addToCart,
  updateCartItem,
  checkout,
  mergeCart,
  removeCartItem,
  bulkRemove,
  clearCart,
  getCart
} = require('../controllers/cart.controller');

const { verifyToken } = require('../middlewares/auth');

// Get logged-in user's cart
router.get('/', verifyToken, getCart);

// Add item to cart
router.post('/', verifyToken, addToCart);

// Update quantity (or remove if qty <= 0)
router.put('/item', verifyToken, updateCartItem);

// Remove single item
router.delete('/item', verifyToken, removeCartItem);

// Bulk remove items
router.post('/bulk-remove', verifyToken, bulkRemove);

// Clear full cart
router.delete('/clear', verifyToken, clearCart);

// Merge guest cart after login
router.post('/merge', verifyToken, mergeCart);

// Checkout
router.post('/checkout', verifyToken, checkout);

module.exports = router;