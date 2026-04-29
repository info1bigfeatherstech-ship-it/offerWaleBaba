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

const { verifyToken } = require('../middlewares/auth.middleware');
const { resolveStorefrontMiddleware } = require('../middlewares/storefront.middleware');

// Get logged-in user's cart
router.get('/', resolveStorefrontMiddleware, verifyToken, getCart);

// Add item to cart
router.post('/', resolveStorefrontMiddleware, verifyToken, addToCart);

// Update quantity (or remove if qty <= 0)
router.put('/item', resolveStorefrontMiddleware, verifyToken, updateCartItem);

// Remove single item
router.delete('/item', resolveStorefrontMiddleware, verifyToken, removeCartItem);

// Bulk remove items
router.post('/bulk-remove', resolveStorefrontMiddleware, verifyToken, bulkRemove);

// Clear full cart
router.delete('/clear', resolveStorefrontMiddleware, verifyToken, clearCart);

// Merge guest cart after login
router.post('/merge', resolveStorefrontMiddleware, verifyToken, mergeCart);



module.exports = router;