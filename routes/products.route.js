// const express = require('express');
// const router = express.Router();
// const userProductController = require('../controllers/user-product.controller');
// // const userTypeMiddleware = require('../middlewares/userTypeMiddleware');
// const {verifyToken} = require('../middlewares/auth.middleware');
// const { getProductDetails } = require('../controllers/user-product.controller');
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
const userProductController = require('../controllers/user-product.controller');
const { optionalAuth } = require('../middlewares/user-type-optional.middleware');
const { resolveStorefrontMiddleware } = require('../middlewares/storefront.middleware');

// Storefront first (ecomm default), then optional auth for wholesaler pricing.
router.get(
  '/search',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.searchProducts
);
router.get(
  '/all',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProducts
);
router.get(
  '/featured',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getFeaturedProducts
);
router.get(
  '/category/:slug',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProductsByCategory
);
router.get(
  '/:slug/related',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getRelatedProducts
);
router.get(
  '/detailed/:id',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProductDetails
);
router.get(
  '/:slug',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProductBySlug
);

module.exports = router;