const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { quoteCheckout } = require('../controllers/checkout.controller');

router.post('/quote', verifyToken, quoteCheckout);

module.exports = router;
