const express = require('express');
const router = express.Router();
const userProductController = require('../controllers/userProductController');

// Search should come before dynamic slug route
router.get('/products/search', userProductController.searchProducts);

// Featured
router.get('/products/featured', userProductController.getFeaturedProducts);

// Products by category (category slug)
router.get('/products/category/:slug', userProductController.getProductsByCategory);

// Related products (by product slug) - define before single product route
router.get('/products/:slug/related', userProductController.getRelatedProducts);

// Single product by slug
router.get('/products/:slug', userProductController.getProductBySlug);

// List products (paginated, filters via query)
router.get('/products', userProductController.getProducts);

module.exports = router;
