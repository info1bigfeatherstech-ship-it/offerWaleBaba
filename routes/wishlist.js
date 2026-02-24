const express = require('express');
const router = express.Router();
const wishlistController = require('../controllers/wishlistController');

// Get wishlist - requires wishlistId or userId query
router.get('/wishlist', wishlistController.getWishlist);

// Add product to wishlist (body: productSlug, wishlistId?, userId?)
router.post('/wishlist/add', wishlistController.addToWishlist);

// Remove from wishlist (param: productSlug) - requires wishlistId or userId query
router.delete('/wishlist/remove/:productSlug', wishlistController.removeFromWishlist);

// Move wishlist item to cart (placeholder) - removes and returns product
router.post('/wishlist/move-to-cart/:productSlug', wishlistController.moveToCart);

module.exports = router;
