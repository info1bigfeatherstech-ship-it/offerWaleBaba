const express = require('express');
const router = express.Router();
const userProductController = require('../controllers/userProductController');

// Search should come before dynamic slug route
router.get('/search', userProductController.searchProducts);

// List products (paginated, filters via query)
router.get('/all', userProductController.getProducts);

// Featured
router.get('/featured', userProductController.getFeaturedProducts);

// Products by category (category slug)
router.get('/category/:slug', userProductController.getProductsByCategory);

// Related products (by product slug) - define before single product route
router.get('/:slug/related', userProductController.getRelatedProducts);

// Single product by slug
router.get('/:slug', userProductController.getProductBySlug);



module.exports = router;
