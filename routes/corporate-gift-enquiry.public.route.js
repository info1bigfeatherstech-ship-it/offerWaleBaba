/**
 * Public corporate / customise-gift enquiry submit (guest OK; optionalAuth may attach userId).
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { uploadGiftEnquiryFiles } = require('../middlewares/upload.middleware');
const { submitCorporateGiftEnquiry } = require('../controllers/corporate-gift-enquiry.controller');
const { MIN_MESSAGE_LEN, MAX_MESSAGE_LEN } = require('../utils/corporateGiftEnquiryValidation');

const router = express.Router();

function rejectValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_FAILED',
      message: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array(),
    });
  }
  return next();
}

router.post(
  '/',
  uploadGiftEnquiryFiles,
  [
    body('enquiryType')
      .trim()
      .notEmpty()
      .withMessage('enquiryType is required')
      .isIn(['custom', 'bulk'])
      .withMessage('enquiryType must be custom or bulk'),
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ min: 2, max: 120 }),
    body('email').trim().notEmpty().withMessage('Email is required').isLength({ max: 254 }),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('city').trim().notEmpty().withMessage('City is required').isLength({ min: 2, max: 120 }),
    body('organizationName').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 160 }),
    body('occasion')
      .trim()
      .notEmpty()
      .withMessage('Occasion is required')
      .isLength({ min: 2, max: 120 }),
    body('giftCategory')
      .trim()
      .notEmpty()
      .withMessage('Gift category is required')
      .isLength({ min: 2, max: 120 }),
    body('quantity').trim().notEmpty().withMessage('Quantity is required'),
    body('targetDeliveryDate').optional({ nullable: true, checkFalsy: true }).trim(),
    body('message')
      .trim()
      .notEmpty()
      .withMessage('Customization notes are required')
      .isLength({ min: MIN_MESSAGE_LEN, max: MAX_MESSAGE_LEN })
      .withMessage(`Customization notes must be ${MIN_MESSAGE_LEN}–${MAX_MESSAGE_LEN} characters`),
  ],
  rejectValidationErrors,
  submitCorporateGiftEnquiry
);

module.exports = router;
