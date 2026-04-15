// const express = require('express');
// const router = express.Router();
// const { registerWholesaler, approveWholesaler } = require('../controllers/wholesaler.controller');
// const {verifyToken} = require('../middlewares/auth.middleware');
// const {requireAdmin}= require('../middlewares/is-admin.middleware');

// // Register as a wholesaler
// router.post('/register', verifyToken, registerWholesaler);

// // Approve wholesaler (admin only)
// router.put('/approve/:id', verifyToken, requireAdmin, approveWholesaler);

// module.exports = router;