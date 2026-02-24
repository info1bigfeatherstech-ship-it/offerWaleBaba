const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const mongoose = require('mongoose');

// GET /wishlist?wishlistId=... OR ?userId=...
const getWishlist = async (req, res) => {
  try {
    const { wishlistId, userId } = req.query;

    let wishlist = null;

    if (wishlistId && mongoose.Types.ObjectId.isValid(wishlistId)) {
      wishlist = await Wishlist.findById(wishlistId).populate('products.productId');
    } else if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      wishlist = await Wishlist.findOne({ userId }).populate('products.productId');
    } else {
      return res.status(400).json({ success: false, message: 'Provide wishlistId or userId' });
    }

    if (!wishlist) return res.json({ success: true, wishlist: { products: [] } });

    return res.json({ success: true, wishlist });
  } catch (err) {
    console.error('getWishlist:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /wishlist/add
// body: { productSlug, wishlistId?, userId? }
const addToWishlist = async (req, res) => {
  try {
    const { productSlug, wishlistId, userId } = req.body;

    if (!productSlug) return res.status(400).json({ success: false, message: 'productSlug required' });

    const product = await Product.findOne({ slug: String(productSlug).toLowerCase(), status: 'active' });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    let wishlist = null;

    if (wishlistId && mongoose.Types.ObjectId.isValid(wishlistId)) {
      wishlist = await Wishlist.findById(wishlistId);
    } else if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      wishlist = await Wishlist.findOne({ userId });
      if (!wishlist) wishlist = new Wishlist({ userId, products: [] });
    } else {
      // create anonymous wishlist
      wishlist = new Wishlist({ products: [] });
    }

    const exists = wishlist.products.some(p => String(p.productId) === String(product._id));
    if (!exists) {
      wishlist.products.push({ productId: product._id });
      await wishlist.save();
    }

    const populated = await Wishlist.findById(wishlist._id).populate('products.productId');

    return res.json({ success: true, wishlist: populated, wishlistId: wishlist._id });
  } catch (err) {
    console.error('addToWishlist:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /wishlist/remove/:productSlug?wishlistId=...&userId=...
const removeFromWishlist = async (req, res) => {
  try {
    const { productSlug } = req.params;
    const { wishlistId, userId } = req.query;

    if (!productSlug) return res.status(400).json({ success: false, message: 'productSlug required' });

    const product = await Product.findOne({ slug: String(productSlug).toLowerCase() });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    let wishlist = null;
    if (wishlistId && mongoose.Types.ObjectId.isValid(wishlistId)) wishlist = await Wishlist.findById(wishlistId);
    else if (userId && mongoose.Types.ObjectId.isValid(userId)) wishlist = await Wishlist.findOne({ userId });
    else return res.status(400).json({ success: false, message: 'Provide wishlistId or userId' });

    if (!wishlist) return res.status(404).json({ success: false, message: 'Wishlist not found' });

    wishlist.products = wishlist.products.filter(p => String(p.productId) !== String(product._id));
    await wishlist.save();

    const populated = await Wishlist.findById(wishlist._id).populate('products.productId');
    return res.json({ success: true, wishlist: populated });
  } catch (err) {
    console.error('removeFromWishlist:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /wishlist/move-to-cart/:productSlug?wishlistId=...&userId=...
// For now: remove item from wishlist and return product data (cart not implemented)
const moveToCart = async (req, res) => {
  try {
    const { productSlug } = req.params;
    const { wishlistId, userId } = req.query;

    if (!productSlug) return res.status(400).json({ success: false, message: 'productSlug required' });

    const product = await Product.findOne({ slug: String(productSlug).toLowerCase(), status: 'active' });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    let wishlist = null;
    if (wishlistId && mongoose.Types.ObjectId.isValid(wishlistId)) wishlist = await Wishlist.findById(wishlistId);
    else if (userId && mongoose.Types.ObjectId.isValid(userId)) wishlist = await Wishlist.findOne({ userId });
    else return res.status(400).json({ success: false, message: 'Provide wishlistId or userId' });

    if (!wishlist) return res.status(404).json({ success: false, message: 'Wishlist not found' });

    wishlist.products = wishlist.products.filter(p => String(p.productId) !== String(product._id));
    await wishlist.save();

    return res.json({ success: true, message: 'Moved to cart (placeholder)', product });
  } catch (err) {
    console.error('moveToCart:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  moveToCart
};
