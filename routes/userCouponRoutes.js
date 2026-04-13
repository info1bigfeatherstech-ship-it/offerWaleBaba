const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { validateCoupon, getAvailableCoupons } = require('../controllers/couponController');

router.use(verifyToken);

router.post('/validate', validateCoupon);
router.get('/available', getAvailableCoupons);

module.exports = router;
