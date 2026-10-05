'use strict';

/**
 * Dropshipper module entry.
 * Isolated from ecomm/wholesale cart, checkout, and User auth.
 *
 * Phase 1: admin product visibility & pricing
 * Phase 2: serviceability check (warehouse → customer)
 * Phase 3: dropshipper catalog (list / detail / download-pack)
 * Phase 4: create order + Razorpay (online only) + admin dropship order list
 * Phase A (auth): settings + accounts + registration requests (approve/reject)
 * Phase B: register + Razorpay subscription pay
 * Phase C: OTP + set password + activate 1-year subscription
 * Phase D: dropshipper login JWT (replaces staff JWT gate on panel APIs)
 * Later: renew
 */

const express = require('express');

const adminDropshipperRouter = express.Router();
adminDropshipperRouter.use(require('./routes/adminDropshipProduct.route'));
adminDropshipperRouter.use(require('./routes/adminDropshipperAuth.route'));

const dropshipperRouter = express.Router();
dropshipperRouter.use(require('./routes/dropshipperAuthPublic.route'));
dropshipperRouter.use(require('./routes/dropshipper.route'));

module.exports = {
  /** Mount: /api/admin/dropshipper */
  adminDropshipProductRoutes: adminDropshipperRouter,
  /** Mount: /api/dropshipper */
  dropshipperRoutes: dropshipperRouter
};
