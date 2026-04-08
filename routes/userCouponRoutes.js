// // routes/userCouponRoutes.js
// const express = require('express');
// const router = express.Router();
// const { verifyToken } = require('../middlewares/auth');
// const {
//     validateCoupon,
//     getAvailableCoupons
// } = require('../controllers/couponController');

// // All routes require authentication
// router.use(verifyToken);

// // Validate coupon before checkout
// router.post('/validate', validateCoupon);

// // Get all available coupons for user
// router.get('/available', getAvailableCoupons);

// module.exports = router;