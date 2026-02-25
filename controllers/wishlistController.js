const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const mongoose = require('mongoose');

// GET /wishlist?wishlistId=... OR ?userId=...
const getWishlist = async (req, res) => {
  try {
    const userId = req.userId;

    const wishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: 'name slug images variants'
      });

    if (!wishlist) {
      return res.json({
        success: true,
        wishlist: { products: [] }
      });
    }

    wishlist.products = wishlist.products.filter(p => p.productId);

    return res.json({
      success: true,
      wishlist
    });

  } catch (err) {
    console.error('getWishlist:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
// POST /wishlist/add
// body: { productSlug, wishlistId?, userId? }
const addToWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const { productSlug, variantId } = req.body;

    if (!productSlug)
      return res.status(400).json({ success: false, message: 'productSlug required' });

    const product = await Product.findOne({ slug: productSlug.toLowerCase(), status: 'active' }).select('variants');

    if (!product)
      return res.status(404).json({ success: false, message: 'Product not found' });

    // Determine variantId to store: provided or first active variant
    let chosenVariantId = variantId;
    if (!chosenVariantId) {
      const firstActive = (product.variants || []).find(v => v.isActive);
      chosenVariantId = firstActive ? firstActive._id : null;
    }

    await Wishlist.updateOne(
      { userId },
      {
        $addToSet: {
          products: { productId: product._id, variantId: chosenVariantId }
        }
      },
      { upsert: true }
    );

    const wishlist = await Wishlist.findOne({ userId }).populate('products.productId', 'name slug images variants');

    return res.json({ success: true, wishlist });

  } catch (err) {
    console.error('addToWishlist:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};


// DELETE /wishlist/remove/:productSlug?wishlistId=...&userId=...
const removeFromWishlist = async (req, res) => {
  try {
    const { productSlug } = req.params;
    const userId = req.userId;

    if (!productSlug)
      return res.status(400).json({ success: false, message: 'productSlug required' });

    const product = await Product.findOne({
      slug: productSlug.toLowerCase(),
      status: 'active'
    });

    if (!product)
      return res.status(404).json({ success: false, message: 'Product not found' });

    await Wishlist.updateOne(
      { userId },
      {
        $pull: {
          products: { productId: product._id }
        }
      }
    );

    const wishlist = await Wishlist.findOne({ userId }).populate(
      'products.productId',
      'name slug price images'
    );

    return res.json({ success: true, wishlist });

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

    const product = await Product.findOne({ slug: String(productSlug).toLowerCase(), status: 'active' }).select('variants');
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



const mergeWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid slugs array' });
    }

    // Find active products matching slugs
    const products = await Product.find({
      slug: { $in: slugs.map(s => s.toLowerCase()) },
      status: 'active'
    }).select('_id');

    if (!products.length) {
      return res.json({ success: true, message: "No products to merge" }); // nothing to merge
    }

    const productEntries = products.map(p => ({
      productId: p._id
    }));

    await Wishlist.updateOne(
      { userId },
      {
        $addToSet: {
          products: { $each: productEntries }
        }
      },
      { upsert: true }
    );

    return res.json({ success: true  , message: "Wishlist merged successfully" });

  } catch (err) {
    console.error('mergeWishlist:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};


//Bulk remove from wishlist
const removeBulkFromWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array required"
      });
    }

    const products = await Product.find({
      slug: { $in: slugs.map(s => s.toLowerCase()) },
      status: "active"
    }).select("_id");

    const productIds = products.map(p => p._id);

    if (productIds.length > 0) {
      await Wishlist.updateOne(
        { userId },
        {
          $pull: {
            products: { productId: { $in: productIds } }
          }
        }
      );
    }

    const updatedWishlist = await Wishlist.findOne({ userId })
      .populate("products.productId", "name slug price images")
      .lean();

    return res.json({
      success: true,
      wishlist: updatedWishlist || { products: [] }
    });

  } catch (err) {
    console.error("removeBulkFromWishlist:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};


const clearWishlist = async (req, res) => {
  try {
    const userId = req.userId;

    const wishlist = await Wishlist.findOneAndUpdate(
      { userId },
      { $set: { products: [] } },
      { new: true }
    ).lean();

    return res.json({
      success: true,
      message: "Wishlist cleared",
      wishlist: wishlist || { products: [] }
    });

  } catch (err) {
    console.error("clearWishlist:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};


module.exports = {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  moveToCart,
  mergeWishlist,
  removeBulkFromWishlist,
  clearWishlist
};
