// routes/deliveryRoutes.js
const express = require('express');
const router = express.Router();
const {verifyToken} = require('../middlewares/auth ');
const {
  checkDeliveryAvailability,
  getDeliveryCharges
} = require('../controllers/deliveryController');

// Check delivery availability (requires auth)
router.post('/check-delivery', verifyToken, checkDeliveryAvailability);

// Get delivery charges by pincode (public, can be without auth)
router.get('/delivery-charges/:pincode', getDeliveryCharges);

module.exports = router;