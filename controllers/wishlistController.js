const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');


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
// const moveToCart = async (req, res) => {
//   try {
//     const { productSlug } = req.params;
//     const userId = req.userId;

//     if (!productSlug)
//       return res.status(400).json({ success: false, message: 'productSlug required' });

//     const product = await Product.findOne({
//       slug: productSlug.toLowerCase(),
//       status: 'active'
//     }).select('_id');

//     if (!product)
//       return res.status(404).json({ success: false, message: 'Product not found' });

//     await Wishlist.updateOne(
//       { userId },
//       { $pull: { products: { productId: product._id } } }
//     );

//     return res.json({
//       success: true,
//       message: 'Moved to cart (placeholder)',
//       productId: product._id
//     });

//   } catch (err) {
//     console.error('moveToCart:', err);
//     return res.status(500).json({ success: false, message: 'Server error' });
//   }
// };
const moveToCart = async (req, res) => {
  const userId = req.userId;
  const { productIds = [], moveAll = false } = req.body;

  if (!userId)
    return res.status(401).json({ success: false, message: 'Unauthorized' });

  try {
    const wishlist = await Wishlist.findOne({ userId });

    if (!wishlist || !wishlist.products.length)
      return res.status(400).json({ success: false, message: 'Wishlist empty' });

    // Decide which products to move
    let itemsToMove = [];

    if (moveAll) {
      itemsToMove = wishlist.products;
    } else {
      itemsToMove = wishlist.products.filter(p =>
        productIds.includes(String(p.productId))
      );
    }

    if (!itemsToMove.length)
      return res.status(400).json({ success: false, message: 'No items selected' });

    let cart = await Cart.findOne({ userId });
    if (!cart) cart = new Cart({ userId, items: [] });

    for (const item of itemsToMove) {
      const product = await Product.findById(item.productId).select('variants status');

      if (!product || product.status !== 'active') continue;

      const variant = product.variants.find(v => v.isActive);
      if (!variant) continue;

      const existing = cart.items.find(it =>
        String(it.productId) === String(product._id) &&
        String(it.variantId) === String(variant._id)
      );

      if (existing) {
        existing.quantity += 1;
      } else {
        cart.items.push({
          productId: product._id,
          variantId: variant._id,
          quantity: 1,
          priceSnapshot: {
            base: variant.price?.base ?? 0,
            sale: variant.price?.sale ?? null,
            costPrice: variant.price?.costPrice ?? null,
            saleStartDate: variant.price?.saleStartDate ?? null,
            saleEndDate: variant.price?.saleEndDate ?? null
          },
          variantAttributesSnapshot: (variant.attributes || []).map(a => ({
            key: a.key,
            value: a.value
          }))
        });
      }
    }

    cart.calculateTotal();
    await cart.save();

    // Remove moved items from wishlist
    if (moveAll) {
      wishlist.products = [];
    } else {
      wishlist.products = wishlist.products.filter(p =>
        !productIds.includes(String(p.productId))
      );
    }

    await wishlist.save();

    return res.json({
      success: true,
      message: 'Wishlist items moved to cart',
      cart
    });

  } catch (err) {
    console.error('moveWishlistToCart:', err);
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
