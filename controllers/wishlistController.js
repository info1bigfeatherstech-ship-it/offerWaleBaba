const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const Cart = require('../models/cart');

// ✅ HELPER: Calculate discount percentage
const calculateDiscountPercentage = (base, sale) => {
  if (!sale || sale <= 0 || sale >= base) return 0;
  return Math.round(((base - sale) / base) * 100);
};

// ✅ HELPER: Get variant price based on user type with virtuals
const getVariantPrice = (variant, userType) => {
  if (userType === 'wholesaler') {
    const base = variant.price?.wholesaleBase || variant.price?.base || 0;
    const sale = variant.price?.wholesaleSale || variant.price?.wholesaleBase || variant.price?.base || 0;
    const isSaleActive = sale > 0 && sale < base;
    const discountPercentage = isSaleActive ? calculateDiscountPercentage(base, sale) : 0;
    
    return {
      base: base,
      sale: sale,
      current: isSaleActive ? sale : base,
      isSaleActive: isSaleActive,
      discountPercentage: discountPercentage,
      minimumOrderQuantity: variant.minimumOrderQuantity || 1
    };
  }
  
  // Normal user
  const base = variant.price?.base || 0;
  const sale = variant.price?.sale || null;
  const isSaleActive = sale && sale > 0 && sale < base;
  const discountPercentage = isSaleActive ? calculateDiscountPercentage(base, sale) : 0;
  
  return {
    base: base,
    sale: sale,
    current: isSaleActive ? sale : base,
    isSaleActive: isSaleActive,
    discountPercentage: discountPercentage,
    minimumOrderQuantity: 1
  };
};

// ✅ HELPER: Format variant with all virtual fields
const formatVariantWithVirtuals = (variant, userType) => {
  const price = getVariantPrice(variant, userType);
  
  return {
    _id: variant._id,
    sku: variant.sku,
    productCode: variant.productCode,
    attributes: variant.attributes || [],
    images: variant.images || [],
    inventory: variant.inventory || {},
    price: {
      base: price.base,
      sale: price.sale,
      current: price.current,
      isSaleActive: price.isSaleActive,
      discountPercentage: price.discountPercentage,
      ...(userType === 'wholesaler' && {
        wholesaleBase: variant.price?.wholesaleBase,
        wholesaleSale: variant.price?.wholesaleSale,
        minimumOrderQuantity: variant.minimumOrderQuantity
      })
    },
    isActive: variant.isActive,
    wholesale: variant.wholesale || false,
    minimumOrderQuantity: variant.minimumOrderQuantity || 1,
    // ✅ Virtual fields
    isSaleActive: price.isSaleActive,
    finalPrice: price.current,
    discountPercentage: price.discountPercentage
  };
};

// ✅ HELPER: Format wishlist item response (SAME AS CART RESPONSE)
const formatWishlistItem = (item, userType) => {
  const product = item.productId;
  if (!product) return null;
  
  // Find the specific variant
  let variant = null;
  if (item.variantId) {
    variant = product.variants?.find(v => String(v._id) === String(item.variantId));
  }
  
  // If no variant found, use first active variant
  if (!variant) {
    variant = (product.variants || []).find(v => v.isActive);
  }
  
  if (!variant) return null;
  
  // ✅ Format variant with all virtuals
  const formattedVariant = formatVariantWithVirtuals(variant, userType);
  
  // ✅ FULL PRODUCT RESPONSE with variants array
  const productObj = product.toObject ? product.toObject() : product;
  
  return {
    _id: item._id,
    addedAt: item.addedAt,
    product: {
      ...productObj,
      variants: [formattedVariant]  // Only the selected variant in wishlist
    }
  };
};

// =============================================
// GET WISHLIST
// =============================================
const getWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const userType = req.userType || 'user';

    const wishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: 'name slug variants images brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt'
      });

    if (!wishlist) {
      return res.json({
        success: true,
        wishlist: { products: [] },
        userType: userType
      });
    }

    // ✅ Format each item with full product and variant data
    const formattedProducts = wishlist.products
      .map(item => formatWishlistItem(item, userType))
      .filter(item => item !== null);

    return res.json({
      success: true,
      wishlist: {
        _id: wishlist._id,
        userId: wishlist.userId,
        products: formattedProducts,
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

// =============================================
// ADD TO WISHLIST
// =============================================
const addToWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const { productSlug, variantId } = req.body;
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
    }).select('name slug variants images brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt');

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    // Check if variant exists
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

    // Check if already in wishlist
    const existingWishlist = await Wishlist.findOne({ userId });
    if (existingWishlist) {
      const alreadyExists = existingWishlist.products.some(p => 
        String(p.productId) === String(product._id) &&
        String(p.variantId) === String(chosenVariantId)
      );
      
      if (alreadyExists) {
        return res.status(400).json({ 
          success: false, 
          message: 'Product already in wishlist' 
        });
      }
    }

    // Add to wishlist
    await Wishlist.updateOne(
      { userId },
      {
        $addToSet: {
          products: { productId: product._id, variantId: chosenVariantId }
        }
      },
      { upsert: true }
    );

    // Get updated wishlist with full data
    const updatedWishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: 'name slug variants images brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt'
      });

    const formattedProducts = updatedWishlist.products
      .map(item => formatWishlistItem(item, userType))
      .filter(item => item !== null);

    return res.json({ 
      success: true, 
      message: 'Added to wishlist',
      wishlist: {
        _id: updatedWishlist._id,
        userId: updatedWishlist.userId,
        products: formattedProducts,
        createdAt: updatedWishlist.createdAt,
        updatedAt: updatedWishlist.updatedAt
      },
      userType: userType
    });

  } catch (err) {
    console.error('addToWishlist:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// REMOVE FROM WISHLIST
// =============================================
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
    }).select('_id');

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

    // Get updated wishlist
    const updatedWishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: 'name slug variants images brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt'
      });

    if (!updatedWishlist) {
      return res.json({ 
        success: true, 
        wishlist: { products: [] },
        userType: userType
      });
    }

    const formattedProducts = updatedWishlist.products
      .map(item => formatWishlistItem(item, userType))
      .filter(item => item !== null);

    return res.json({
      success: true,
      wishlist: {
        _id: updatedWishlist._id,
        userId: updatedWishlist.userId,
        products: formattedProducts,
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

// =============================================
// MOVE TO CART
// =============================================
const moveToCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
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

    // Get full product details
    const productIdsList = itemsToMove.map(item => item.productId);
    const products = await Product.find({ 
      _id: { $in: productIdsList },
      status: 'active'
    }).select('name slug variants images brand');

    const productMap = new Map();
    products.forEach(product => {
      productMap.set(String(product._id), product);
    });

    let cart = await Cart.findOne({ userId });
    if (!cart) cart = new Cart({ userId, items: [] });

    for (const item of itemsToMove) {
      const product = productMap.get(String(item.productId));
      if (!product) continue;

      // Find the variant
      let variant = null;
      if (item.variantId) {
        variant = product.variants.find(v => String(v._id) === String(item.variantId));
      }
      if (!variant) {
        variant = product.variants.find(v => v.isActive);
      }
      if (!variant) continue;

      // Calculate price based on user type (with discount)
      let basePrice, salePrice, isSaleActive, discountPercentage;
      if (userType === 'wholesaler') {
        basePrice = variant.price?.wholesaleBase || variant.price?.base || 0;
        salePrice = variant.price?.wholesaleSale || variant.price?.wholesaleBase || variant.price?.base || 0;
        isSaleActive = salePrice > 0 && salePrice < basePrice;
        discountPercentage = isSaleActive ? calculateDiscountPercentage(basePrice, salePrice) : 0;
      } else {
        basePrice = variant.price?.base || 0;
        salePrice = variant.price?.sale || null;
        isSaleActive = salePrice && salePrice > 0 && salePrice < basePrice;
        discountPercentage = isSaleActive ? calculateDiscountPercentage(basePrice, salePrice) : 0;
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
            isSaleActive: isSaleActive,
            discountPercentage: discountPercentage,
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

// =============================================
// MERGE WISHLIST (Guest to User)
// =============================================
const mergeWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    let { slugs, items } = req.body;

    // Handle old format (slugs array)
    if (slugs && Array.isArray(slugs) && slugs.length > 0) {
      items = slugs.map(slug => ({ slug, variantId: null }));
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid request. Provide slugs array or items array with { slug, variantId }' 
      });
    }

    // Normalize items
    const normalizedItems = [];
    for (const item of items) {
      if (typeof item === 'string') {
        normalizedItems.push({ slug: item, variantId: null });
      } else if (typeof item === 'object' && item.slug) {
        normalizedItems.push({ 
          slug: item.slug, 
          variantId: item.variantId || null 
        });
      }
    }

    if (normalizedItems.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No valid items to merge' 
      });
    }

    // Fetch all products
    const slugsList = normalizedItems.map(item => item.slug.toLowerCase());
    const products = await Product.find({
      slug: { $in: slugsList },
      status: 'active'
    }).select('slug variants');

    const productMap = new Map();
    products.forEach(product => {
      productMap.set(product.slug, product);
    });

    const productEntries = [];

    for (const item of normalizedItems) {
      const product = productMap.get(item.slug.toLowerCase());
      if (!product) continue;

      let chosenVariantId = item.variantId;
      
      if (!chosenVariantId) {
        const firstActive = product.variants.find(v => v.isActive);
        if (firstActive) {
          chosenVariantId = firstActive._id;
        } else {
          continue;
        }
      } else {
        const variantExists = product.variants.some(v => 
          String(v._id) === String(chosenVariantId) && v.isActive
        );
        if (!variantExists) continue;
      }

      // Check if already in wishlist
      const existingWishlist = await Wishlist.findOne({ userId });
      if (existingWishlist) {
        const alreadyExists = existingWishlist.products.some(p => 
          String(p.productId) === String(product._id) &&
          String(p.variantId) === String(chosenVariantId)
        );
        if (alreadyExists) continue;
      }

      productEntries.push({
        productId: product._id,
        variantId: chosenVariantId
      });
    }

    if (productEntries.length === 0) {
      return res.json({ 
        success: true, 
        message: "No new products to add to wishlist" 
      });
    }

    await Wishlist.updateOne(
      { userId },
      {
        $addToSet: {
          products: { $each: productEntries }
        }
      },
      { upsert: true }
    );

    return res.json({ 
      success: true, 
      message: `${productEntries.length} item(s) added to wishlist`,
      mergedCount: productEntries.length
    });

  } catch (err) {
    console.error('mergeWishlist:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// BULK REMOVE FROM WISHLIST
// =============================================
const removeBulkFromWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const { slugs } = req.body;
    const userType = req.userType || 'user';

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
      .populate({
        path: 'products.productId',
        select: 'name slug variants images brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt'
      });

    if (!updatedWishlist) {
      return res.json({
        success: true,
        wishlist: { products: [] },
        userType: userType
      });
    }

    const formattedProducts = updatedWishlist.products
      .map(item => formatWishlistItem(item, userType))
      .filter(item => item !== null);

    return res.json({
      success: true,
      wishlist: {
        _id: updatedWishlist._id,
        userId: updatedWishlist.userId,
        products: formattedProducts,
        createdAt: updatedWishlist.createdAt,
        updatedAt: updatedWishlist.updatedAt
      },
      userType: userType
    });

  } catch (err) {
    console.error("removeBulkFromWishlist:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// =============================================
// CLEAR WISHLIST
// =============================================
const clearWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const userType = req.userType || 'user';

    const wishlist = await Wishlist.findOneAndUpdate(
      { userId },
      { $set: { products: [] } },
      { new: true }
    ).lean();

    return res.json({
      success: true,
      message: "Wishlist cleared",
      wishlist: wishlist || { products: [] },
      userType: userType
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