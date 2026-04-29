const express = require('express');
const router = express.Router();
const wishlistController = require('../controllers/wishlist.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { resolveStorefrontMiddleware } = require('../middlewares/storefront.middleware');

router.get('/', resolveStorefrontMiddleware, verifyToken, wishlistController.getWishlist);

router.post('/add', resolveStorefrontMiddleware, verifyToken, wishlistController.addToWishlist);

router.delete(
  '/remove/:productSlug',
  resolveStorefrontMiddleware,
  verifyToken,
  wishlistController.removeFromWishlist
);

router.post('/merge', resolveStorefrontMiddleware, verifyToken, wishlistController.mergeWishlist);

router.delete(
  '/remove-bulk',
  resolveStorefrontMiddleware,
  verifyToken,
  wishlistController.removeBulkFromWishlist
);

router.delete(
  '/clear',
  resolveStorefrontMiddleware,
  verifyToken,
  wishlistController.clearWishlist
);

router.post(
  '/move-to-cart',
  resolveStorefrontMiddleware,
  verifyToken,
  wishlistController.moveToCart
);

module.exports = router;