const { resolveStorefront } = require('../config/storefront.config');

/**
 * Sets req.storefront to 'ecomm' | 'wholesale' for catalog/cart/wishlist flows.
 */
function resolveStorefrontMiddleware(req, res, next) {
  req.storefront = resolveStorefront(req);
  next();
}

module.exports = { resolveStorefrontMiddleware };
