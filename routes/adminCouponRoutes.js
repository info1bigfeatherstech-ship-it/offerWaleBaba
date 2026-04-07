// routes/adminCouponRoutes.js
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { authorizeRoles } = require('../middlewares/authorizeRoles');
const {
    createCoupon,
    getAllCoupons,
    getCouponById,
    updateCoupon,
    deleteCoupon,
    toggleCouponStatus
} = require('../controllers/couponController');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'product_manager'));

// Coupon CRUD
router.post('/', createCoupon);
router.get('/', getAllCoupons);
router.get('/:id', getCouponById);
router.put('/:id', updateCoupon);
router.delete('/:id', deleteCoupon);
router.patch('/:id/toggle', toggleCouponStatus);

module.exports = router;