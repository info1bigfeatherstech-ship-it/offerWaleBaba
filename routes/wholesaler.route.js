const express = require('express');
const { body, param } = require('express-validator');
const { requireAdmin, requireSuperAdmin } = require('../middlewares/is-admin.middleware');
const {
  submitWholesalerRequest,
  listWholesalerRequests,
  getWholesalerRequestDetails,
  approveWholesalerRequest,
  rejectWholesalerRequest,
  sendWholesalerActivationOtp,
  verifyWholesalerActivationOtp,
  getWholesalerRequestSummary,
  buildNotifyOwnerPayload,
  buildNotifyApplicantPayload,
  getOwnerReviewPage,
  postOwnerReviewDecision
} = require('../controllers/wholesaler.controller');

const router = express.Router();

router.get('/owner-review', getOwnerReviewPage);
router.post(
  '/owner-review/decision',
  [
    body('token').trim().notEmpty().withMessage('token is required'),
    body('decision').isIn(['approve', 'reject']).withMessage('decision must be approve or reject'),
    body('reason').optional().isLength({ max: 500 }).withMessage('reason too long')
  ],
  postOwnerReviewDecision
);

router.post(
  '/request',
  [
    body('fullName').trim().notEmpty().withMessage('fullName is required'),
    body('whatsappNumber').trim().notEmpty().withMessage('whatsappNumber is required'),
    body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required'),
    body('email').trim().isEmail().withMessage('Valid email is required'),
    body('permanentAddress').trim().notEmpty().withMessage('permanentAddress is required'),
    body('businessAddress').trim().notEmpty().withMessage('businessAddress is required'),
    body('deliveryAddress').trim().notEmpty().withMessage('deliveryAddress is required'),
    body('sellingPlaceFrom').trim().notEmpty().withMessage('sellingPlaceFrom is required'),
    body('sellingZoneCity').trim().notEmpty().withMessage('sellingZoneCity is required'),
    body('productCategory').trim().notEmpty().withMessage('productCategory is required'),
    body('monthlyEstimatedPurchase').isNumeric().withMessage('monthlyEstimatedPurchase must be numeric'),
    body('idProofUpload').trim().notEmpty().withMessage('idProofUpload is required'),
    body('businessAddressProofUpload').trim().notEmpty().withMessage('businessAddressProofUpload is required')
  ],
  submitWholesalerRequest
);

router.post(
  '/activate/send-otp',
  [body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required')],
  sendWholesalerActivationOtp
);

router.post(
  '/activate/verify',
  [
    body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required'),
    body('otp').trim().notEmpty().withMessage('otp is required'),
    body('password').isLength({ min: 6 }).withMessage('password must be at least 6 characters')
  ],
  verifyWholesalerActivationOtp
);

router.get('/admin/requests', requireAdmin, listWholesalerRequests);
router.get('/admin/requests/summary', requireAdmin, getWholesalerRequestSummary);
router.get(
  '/admin/requests/:id',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireAdmin,
  getWholesalerRequestDetails
);
router.get(
  '/admin/requests/:id/notify-owner',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireAdmin,
  buildNotifyOwnerPayload
);
router.get(
  '/admin/requests/:id/notify-applicant',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireAdmin,
  buildNotifyApplicantPayload
);
router.post(
  '/admin/requests/:id/approve',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireSuperAdmin,
  approveWholesalerRequest
);
router.post(
  '/admin/requests/:id/reject',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireSuperAdmin,
  rejectWholesalerRequest
);

module.exports = router;
