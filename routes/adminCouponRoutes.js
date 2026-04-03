// routes/adminCouponRoutes.js
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middlewares/isAdmin');
const {
    createCoupon,
    getAllCoupons,
    getCouponById,
    updateCoupon,
    deleteCoupon,
    toggleCouponStatus
} = require('../controllers/couponController');

// All routes require admin authentication
router.use(requireAdmin);

// Coupon CRUD
router.post('/', createCoupon);
router.get('/', getAllCoupons);
router.get('/:id', getCouponById);
router.put('/:id', updateCoupon);
router.delete('/:id', deleteCoupon);
router.patch('/:id/toggle', toggleCouponStatus);

module.exports = router;