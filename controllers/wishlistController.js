const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const Cart = require('../models/cart');


// controllers/wishlistController.js
// GET WISHLIST
const getWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const userType = req.userType || 'user'; // Get user type from middleware

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

    // Filter out deleted products and add user-specific pricing
    const validProducts = wishlist.products.filter(p => p.productId);
    
    // Add user-specific pricing to each product
    const productsWithPricing = validProducts.map(item => {
      const product = item.productId;
      
      // Find the variant (if variantId exists, use that variant)
      let variant = null;
      if (item.variantId) {
        variant = product.variants.find(v => String(v._id) === String(item.variantId));
      }
      
      // If no variant found, use first active variant
      if (!variant) {
        variant = (product.variants || []).find(v => v.isActive);
      }
      
      // Calculate user-specific price
      let price = {};
      if (userType === 'wholesaler') {
        price = {
          base: variant?.price?.wholesaleBase || variant?.price?.base || 0,
          sale: variant?.price?.wholesaleSale || variant?.price?.wholesaleBase || variant?.price?.base || 0,
          minimumOrderQuantity: variant?.minimumOrderQuantity || 1
        };
      } else {
        price = {
          base: variant?.price?.base || 0,
          sale: variant?.price?.sale || variant?.price?.base || 0,
          minimumOrderQuantity: 1
        };
      }
      
      return {
        _id: item._id,
        productId: product._id,
        variantId: item.variantId,
        addedAt: item.addedAt,
        product: {
          _id: product._id,
          name: product.name,
          slug: product.slug,
          images: product.images,
          price: price,
          variant: variant ? {
            _id: variant._id,
            sku: variant.sku,
            attributes: variant.attributes,
            inventory: variant.inventory
          } : null
        }
      };
    });

    return res.json({
      success: true,
      wishlist: {
        _id: wishlist._id,
        userId: wishlist.userId,
        products: productsWithPricing,
        createdAt: wishlist.createdAt,
        updatedAt: wishlist.updatedAt
      },
      userType: userType
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

    if (!productSlug) {
      return res.status(400).json({ 
        success: false, 
        message: 'productSlug required' 
      });
    }

    const product = await Product.findOne({ 
      slug: productSlug.toLowerCase(), 
      status: 'active' 
    }).select('variants');

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    // ✅ Check if variant exists
    let chosenVariantId = variantId;
    if (chosenVariantId) {
      const variantExists = product.variants.some(v => 
        String(v._id) === String(chosenVariantId) && v.isActive
      );
      if (!variantExists) {
        return res.status(400).json({ 
          success: false, 
          message: 'Variant not found or inactive' 
        });
      }
    } else {
      const firstActive = product.variants.find(v => v.isActive);
      if (!firstActive) {
        return res.status(400).json({ 
          success: false, 
          message: 'No active variant available' 
        });
      }
      chosenVariantId = firstActive._id;
    }

    // ✅ Check if already in wishlist to avoid duplicate
    const existingWishlist = await Wishlist.findOne({ userId });
    if (existingWishlist) {
      const alreadyExists = existingWishlist.products.some(p => 
        String(p.productId) === String(product._id) &&
        (!chosenVariantId || String(p.variantId) === String(chosenVariantId))
      );
      
      if (alreadyExists) {
        return res.status(400).json({ 
          success: false, 
          message: 'Product already in wishlist' 
        });
      }
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

    const wishlist = await Wishlist.findOne({ userId })
      .populate('products.productId', 'name slug images variants');

    return res.json({ 
      success: true, 
      message: 'Added to wishlist', 
      wishlist 
    });

  } catch (err) {
    console.error('addToWishlist:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};


// DELETE /wishlist/remove/:productSlug?wishlistId=...&userId=...
// DELETE /wishlist/remove/:productSlug
const removeFromWishlist = async (req, res) => {
  try {
    const { productSlug } = req.params;
    const userId = req.userId;
    const userType = req.userType || 'user';

    if (!productSlug) {
      return res.status(400).json({ 
        success: false, 
        message: 'productSlug required' 
      });
    }

    const product = await Product.findOne({
      slug: productSlug.toLowerCase(),
      status: 'active'
    });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    await Wishlist.updateOne(
      { userId },
      { $pull: { products: { productId: product._id } } }
    );

    // ✅ Fetch updated wishlist with pricing (same as getWishlist)
    const updatedWishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: 'name slug images variants'
      });

    if (!updatedWishlist) {
      return res.json({ success: true, wishlist: { products: [] } });
    }

    // Add user-specific pricing to response
    const validProducts = updatedWishlist.products.filter(p => p.productId);
    const productsWithPricing = validProducts.map(item => {
      const product = item.productId;
      let variant = null;
      
      if (item.variantId) {
        variant = product.variants.find(v => String(v._id) === String(item.variantId));
      }
      if (!variant) {
        variant = (product.variants || []).find(v => v.isActive);
      }
      
      let price = {};
      if (userType === 'wholesaler') {
        price = {
          base: variant?.price?.wholesaleBase || variant?.price?.base || 0,
          sale: variant?.price?.wholesaleSale || variant?.price?.wholesaleBase || variant?.price?.base || 0,
          minimumOrderQuantity: variant?.minimumOrderQuantity || 1
        };
      } else {
        price = {
          base: variant?.price?.base || 0,
          sale: variant?.price?.sale || variant?.price?.base || 0,
          minimumOrderQuantity: 1
        };
      }
      
      return {
        _id: item._id,
        productId: product._id,
        variantId: item.variantId,
        addedAt: item.addedAt,
        product: {
          _id: product._id,
          name: product.name,
          slug: product.slug,
          images: product.images,
          price: price,
          variant: variant ? {
            _id: variant._id,
            sku: variant.sku,
            attributes: variant.attributes,
            inventory: variant.inventory
          } : null
        }
      };
    });

    return res.json({
      success: true,
      wishlist: {
        _id: updatedWishlist._id,
        userId: updatedWishlist.userId,
        products: productsWithPricing,
        createdAt: updatedWishlist.createdAt,
        updatedAt: updatedWishlist.updatedAt
      },
      userType: userType
    });

  } catch (err) {
    console.error('removeFromWishlist:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// POST /wishlist/move-to-cart/:productSlug?wishlistId=...&userId=...
// For now: remove item from wishlist and return product data (cart not implemented)
const moveToCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user'; // Get user type
  const { productIds = [], moveAll = false } = req.body;

  if (!userId)
    return res.status(401).json({ success: false, message: 'Unauthorized' });

  try {
    const wishlist = await Wishlist.findOne({ userId });

    if (!wishlist || !wishlist.products.length)
      return res.status(400).json({ success: false, message: 'Wishlist empty' });

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

      // Find the specific variant or first active variant
      let variant = null;
      if (item.variantId) {
        variant = product.variants.find(v => String(v._id) === String(item.variantId));
      }
      if (!variant) {
        variant = product.variants.find(v => v.isActive);
      }
      if (!variant) continue;

      // ✅ Calculate price based on user type
      let basePrice, salePrice;
      if (userType === 'wholesaler') {
        basePrice = variant.price?.wholesaleBase || variant.price?.base;
        salePrice = variant.price?.wholesaleSale || variant.price?.wholesaleBase || variant.price?.base;
        
        // Check MOQ for wholesaler
        const moq = variant.minimumOrderQuantity || 1;
        // Note: You might want to handle MOQ validation here or in cart
      } else {
        basePrice = variant.price?.base || 0;
        salePrice = variant.price?.sale || basePrice;
      }

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
            base: basePrice,
            sale: salePrice,
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
      cart,
      userType: userType
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
