const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { quoteCheckout } = require('../controllers/checkoutController');

router.post('/quote', verifyToken, quoteCheckout);

module.exports = router;
