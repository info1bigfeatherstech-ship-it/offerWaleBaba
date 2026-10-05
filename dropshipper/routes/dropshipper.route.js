'use strict';

/**
 * Dropshipper-facing routes.
 * Mount: /api/dropshipper
 *
 * Auth: Dropshipper JWT (Phase D). Staff JWT no longer unlocks panel routes.
 * Public auth (register/activate/login) lives on dropshipperAuthPublic.route.js
 * and is mounted before this router in module index.
 */

const express = require('express');
const router = express.Router();
const {
  requireDropshipperAccess,
  requireActiveSubscription
} = require('../middlewares/dropshipperAccess.middleware');
const serviceabilityController = require('../controllers/serviceability.controller');
const catalogController = require('../controllers/catalog.controller');
const orderController = require('../controllers/order.controller');
const loginController = require('../controllers/dropshipperLogin.controller');
const renewController = require('../controllers/dropshipperRenew.controller');

// Authenticated session helpers (login OK even if subscription expired)
router.get('/auth/me', requireDropshipperAccess, loginController.me);
router.post('/auth/logout', requireDropshipperAccess, loginController.logout);

// Phase E — renew allowed for expired (and active early-renew) accounts
router.get('/auth/renew/quote', requireDropshipperAccess, renewController.getRenewQuote);
router.post(
  '/auth/renew/create-payment',
  requireDropshipperAccess,
  renewController.createRenewPayment
);
router.post(
  '/auth/renew/verify-payment',
  requireDropshipperAccess,
  renewController.verifyRenewPayment
);

// Panel APIs — require active subscription year
router.use(requireDropshipperAccess);
router.use(requireActiveSubscription);

// Serviceability
router.post('/serviceability/check', serviceabilityController.checkServiceability);

// Catalog
router.get('/catalog/products', catalogController.listProducts);
router.get('/catalog/products/:slug', catalogController.getProductBySlug);
router.get(
  '/catalog/variants/:productCode/download-pack',
  catalogController.getVariantDownloadPack
);
router.get('/catalog/variants/:productCode', catalogController.getVariantByProductCode);

// Orders + Razorpay (online only)
router.post('/orders/quote', orderController.quoteOrder);
router.post('/orders', orderController.createOrder);
router.post('/orders/verify-payment', orderController.verifyPayment);
router.get('/orders', orderController.listMyOrders);
router.get('/orders/:orderId', orderController.getMyOrder);

module.exports = router;
