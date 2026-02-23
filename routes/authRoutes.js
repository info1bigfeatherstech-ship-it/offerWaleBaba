const express = require('express');
const { body } = require('express-validator');
const { register, login, logout, me, updateProfile, changePassword, forgotPassword, resetPassword, verifyRegistrationOTP, refreshAccessToken, googleAuth , requestPhoneOTP } = require('../controllers/authController');
const { verifyToken } = require('../middlewares/auth');

const router = express.Router();

// POST /api/auth/register
router.post(
  '/register',
  [
    body('email')
      .trim()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('Invalid email format')
      .normalizeEmail(),
    body('password')
      .notEmpty()
      .withMessage('Password is required')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('firstname')
      .trim()
      .notEmpty()
      .withMessage('First name is required')
      .isLength({ min: 2 })
      .withMessage('First name must be at least 2 characters'),
    body('lastname')
      .optional()
      .trim()
      .isLength({ min: 2 })
      .withMessage('Last name must be at least 2 characters'),
  ],
  register
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email')
      .trim()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('Invalid email format')
      .normalizeEmail(),
    body('password')
      .notEmpty()
      .withMessage('Password is required')
  ],
  login
);

// POST /api/auth/otp-verify-login
router.post(
  '/otp-verify-login',
  [
    body('email').trim().notEmpty().withMessage('Email is required').isEmail().withMessage('Invalid email format').normalizeEmail(),
    body('otp').trim().notEmpty().withMessage('OTP is required')
  ],
  verifyRegistrationOTP
);

// POST /api/auth/refresh - issues new access token using refresh cookie
router.post('/refresh', refreshAccessToken);

// POST /api/auth/google - Google Sign-In (frontend supplies idToken)
router.post('/google', [
  body('idToken').notEmpty().withMessage('idToken is required')
], googleAuth);



// Additional routes
// POST /api/auth/logout (protected)
router.post('/logout', verifyToken, logout);

// GET /api/auth/me (protected)
router.get('/me', verifyToken, me);

// PUT /api/auth/profile (protected)
router.put('/profile', verifyToken, updateProfile);

// PUT /api/auth/change-password (protected)
router.put('/change-password', verifyToken, changePassword);

// POST /api/auth/forgot-password (public)
router.post('/forgot-password', forgotPassword);

// POST /api/auth/reset-password (public)
router.post('/reset-password', resetPassword);


// 📱 Request OTP
router.post("/phone/request-otp", requestPhoneOTP);

module.exports = router;
