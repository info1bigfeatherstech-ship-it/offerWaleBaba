'use strict';

/**
 * Admin dropshipper auth / subscription management.
 * Mounted under /api/admin/dropshipper (composed in module index).
 *
 * Does not touch ecomm/wholesale users, checkout, or storefront settings.
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../middlewares/auth.middleware');
const { authorizeRoles } = require('../../middlewares/authorize-roles.middleware');
const controller = require('../controllers/adminDropshipperAuth.controller');

const adminOnly = authorizeRoles('admin');
const readRoles = authorizeRoles('admin', 'order_manager', 'product_manager');

router.use(verifyToken);

// Settings
router.get('/settings', readRoles, controller.getAdminSettings);
router.patch('/settings', adminOnly, controller.updateAdminSettings);

// Dropshipper accounts
router.get('/accounts', readRoles, controller.listAccounts);
router.get('/accounts/:id', readRoles, controller.getAccount);

// Registration / renew requests
router.get('/requests', readRoles, controller.listRequests);
router.get('/requests/:id', readRoles, controller.getRequest);
router.post('/requests/:id/approve', adminOnly, controller.approveRequest);
router.post('/requests/:id/reject', adminOnly, controller.rejectRequest);

module.exports = router;
