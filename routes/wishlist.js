const express = require('express');
const router = express.Router();
const wishlistController = require('../controllers/wishlistController');
const {verifyToken} = require('../middlewares/auth'); // your auth middleware


router.get('/', verifyToken, wishlistController.getWishlist);

router.post('/add', verifyToken, wishlistController.addToWishlist);

router.delete('/remove/:productSlug', verifyToken, wishlistController.removeFromWishlist);

router.post('/merge', verifyToken, wishlistController.mergeWishlist);

router.delete(
  "/remove-bulk",
  verifyToken,
  wishlistController.removeBulkFromWishlist
);

router.delete(
  "/clear",
  verifyToken,
  wishlistController.clearWishlist
);


module.exports = router;