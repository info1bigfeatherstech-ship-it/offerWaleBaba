const express = require('express');
const router = express.Router();
const { registerWholesaler, approveWholesaler } = require('../controllers/wholesalerController');
const {verifyToken} = require('../middlewares/auth');
const {requireAdmin}= require('../middlewares/isAdmin');

// Register as a wholesaler
router.post('/register', verifyToken, registerWholesaler);

// Approve wholesaler (admin only)
router.put('/approve/:id', verifyToken, requireAdmin, approveWholesaler);

module.exports = router;