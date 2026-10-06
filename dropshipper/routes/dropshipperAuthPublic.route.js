'use strict';

/**
 * Public dropshipper auth endpoints (no JWT).
 * Registration / activation / login UI (dropshipper-dashboard FE) consumes these.
 * Does not use ecomm/wholesale storefront headers.
 */

const express = require('express');
const router = express.Router();
const { uploadWholesalerProofs } = require('../../middlewares/upload.middleware');
const settingsController = require('../controllers/adminDropshipperAuth.controller');
const registerController = require('../controllers/dropshipperRegister.controller');
const activateController = require('../controllers/dropshipperActivate.controller');
const loginController = require('../controllers/dropshipperLogin.controller');

/** Multer for registration proofs — map errors to dropshipper JSON contract. */
function withRegistrationProofUpload(req, res, next) {
  uploadWholesalerProofs(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Proof file must be 5MB or smaller'
        : err.message || 'Invalid proof file';
    return res.status(400).json({
      success: false,
      code: 'PROOF_UPLOAD_INVALID',
      message
    });
  });
}

// Subscription fee preview
router.get('/auth/subscription-settings', settingsController.getPublicSubscriptionSettings);

// Registration + subscription payment (Phase B)
// create-payment accepts multipart (idProof + businessAddressProof → Cloudinary)
router.post('/auth/register/start', registerController.startRegistration);
router.post(
  '/auth/register/create-payment',
  withRegistrationProofUpload,
  registerController.createRegistrationPayment
);
router.post('/auth/register/verify-payment', registerController.verifyRegistrationPayment);
router.get('/auth/register/status/:requestId', registerController.getRegistrationStatus);

// Activation after admin approve (Phase C)
router.post('/auth/activate/send-otp', activateController.sendActivationOtp);
router.post('/auth/activate/complete', activateController.completeActivation);

// Login / refresh (Phase D) — no prior JWT required
router.post('/auth/login', loginController.login);
router.post('/auth/refresh', loginController.refresh);

module.exports = router;
