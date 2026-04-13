const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { checkDeliveryAvailability, getDeliveryCharges } = require('../controllers/deliveryController');

router.post('/check-delivery', verifyToken, checkDeliveryAvailability);
router.get('/delivery-charges/:pincode', getDeliveryCharges);

module.exports = router;
