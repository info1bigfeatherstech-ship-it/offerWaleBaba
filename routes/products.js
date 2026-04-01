// const express = require('express');
// const router = express.Router();
// const userProductController = require('../controllers/userProductController');
// // const userTypeMiddleware = require('../middlewares/userTypeMiddleware');
// const {verifyToken} = require('../middlewares/auth');
// const { getProductDetails } = require('../controllers/userProductController');
// // Apply userTypeMiddleware to product routes
// // router.use(userTypeMiddleware);

// // Search should come before dynamic slug route
// router.get('/search', userProductController.searchProducts);

// // List products (paginated, filters via query)
// router.get('/all', userProductController.getProducts);

// // Featured
// router.get('/featured', userProductController.getFeaturedProducts);

// // Products by category (category slug)
// router.get('/category/:slug', userProductController.getProductsByCategory);


// // Related products (by product slug) - define before single product route
// router.get('/:slug/related', userProductController.getRelatedProducts);


// // Add route for getting product details with user-specific pricing
// router.get('/detailed/:id',   getProductDetails);
  


// // Single product by slug
// router.get('/:slug', userProductController.getProductBySlug);


// module.exports = router;


// routes/userProductRoutes.js
const express = require('express');
const router = express.Router();
const userProductController = require('../controllers/userProductController');
const { optionalAuth } = require('../middlewares/userTypeOptional');

// ✅ All product routes are PUBLIC, but if user is logged in,
//    they get their userType (wholesaler or user)
router.get('/search', optionalAuth, userProductController.searchProducts);
router.get('/all', optionalAuth, userProductController.getProducts);
router.get('/featured', optionalAuth, userProductController.getFeaturedProducts);
router.get('/category/:slug', optionalAuth, userProductController.getProductsByCategory);
router.get('/:slug/related', optionalAuth, userProductController.getRelatedProducts);
router.get('/detailed/:id', optionalAuth, userProductController.getProductDetails);
router.get('/:slug', optionalAuth, userProductController.getProductBySlug);

module.exports = router;