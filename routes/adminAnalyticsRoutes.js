// routes/adminAnalyticsRoutes.js
const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  getAllCarts,
  getAbandonedCarts,
  getHighValueCarts,
  getAllWishlists,
  getStaleWishlists,
  getPopularWishlistProducts,
  getDashboardSummary
} = require('../controllers/adminAnalyticsController');

// Import your auth middleware (adjust path as needed)
// const { protect, authorize } = require('../middleware/authMiddleware');

//auth middleware 
const {verifyToken}=require("../middlewares/auth");
const {requireAdmin}=require("../middlewares/isAdmin");

// All routes require authentication and admin role
router.use(verifyToken);
router.use(requireAdmin);

// User analytics
router.get('/users', getAllUsers);
router.get('/users/:userId', getUserById);

// Cart analytics
router.get('/carts', getAllCarts);
router.get('/carts/abandoned', getAbandonedCarts);
router.get('/carts/high-value', getHighValueCarts);

// Wishlist analytics
router.get('/wishlists', getAllWishlists);
router.get('/wishlists/stale', getStaleWishlists);
router.get('/wishlists/popular-products', getPopularWishlistProducts);

// Dashboard summary
router.get('/dashboard/summary', getDashboardSummary);

module.exports = router;