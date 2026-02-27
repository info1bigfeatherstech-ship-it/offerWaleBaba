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

//
// ==============================
// CART ROUTES (Authenticated)
// ==============================
//

// Get logged-in user's cart
// GET /api/cart
router.get('/', verifyToken, getCart);

// Add item to cart
// POST /api/cart
router.post('/', verifyToken, addToCart);

// Update quantity (or remove if qty <= 0)
// PUT /api/cart/item
router.put('/item', verifyToken, updateCartItem);

// Remove single item
// DELETE /api/cart/item
router.delete('/item', verifyToken, removeCartItem);

// Bulk remove items
// POST /api/cart/bulk-remove
router.post('/bulk-remove', verifyToken, bulkRemove);

// Clear full cart
// DELETE /api/cart/clear
router.delete('/clear', verifyToken, );

// Merge guest cart after login
// POST /api/cart/merge
router.post('/merge', verifyToken, mergeCart);

// Checkout
// POST /api/cart/checkout
router.post('/checkout', verifyToken, checkout);

module.exports = router;