const mongoose = require('mongoose');
const Cart = require('../models/cart');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Address = require('../models/Address');

// Helper: find variant object inside product document
const findVariant = (product, variantId) => {
  if (!product || !product.variants) return null;
  return product.variants.find(v => String(v._id) === String(variantId));
};

// Helper: compute if sale is valid for a price snapshot
const isSaleValid = (price) => {
  if (!price) return false;
  const now = new Date();
  if (price.sale == null) return false;
  if (price.sale >= price.base) return false;
  if (price.saleStartDate && now < price.saleStartDate) return false;
  if (price.saleEndDate && now > price.saleEndDate) return false;
  return true;
};

// Helper: Get user-specific pricing for a variant
const getUserSpecificPrice = (variant, userType) => {
  if (userType === 'wholesaler') {
    return {
      base: variant.price?.wholesaleBase || variant.price?.base || 0,
      sale: variant.price?.wholesaleSale || variant.price?.wholesaleBase || variant.price?.base || 0,
      moq: variant.minimumOrderQuantity || 1
    };
  }
  return {
    base: variant.price?.base || 0,
    sale: variant.price?.sale || null,
    moq: 1
  };
};

// ✅ HELPER: Calculate discount percentage
const calculateDiscountPercentage = (base, sale) => {
  if (!sale || sale <= 0 || sale >= base) return 0;
  return Math.round(((base - sale) / base) * 100);
};

// ✅ HELPER: Format cart item with FULL variant data (including virtuals)
const formatCartItem = (item, product, variant, userType) => {
  if (!product || !variant) return null;
  
  const price = getUserSpecificPrice(variant, userType);
  
  // Calculate sale validity and discount
  const isSaleValidForVariant = price.sale && price.sale > 0 && price.sale < price.base;
  const discountPercentage = isSaleValidForVariant 
    ? calculateDiscountPercentage(price.base, price.sale)
    : 0;
  
  // Calculate current price
  let currentPrice = isSaleValidForVariant ? price.sale : price.base;
  
  const itemTotal = currentPrice * item.quantity;
  
  // ✅ FULL VARIANT OBJECT with all data including virtuals
  const fullVariant = {
    _id: variant._id,
    sku: variant.sku,
    barcode: variant.barcode,
    attributes: variant.attributes || [],
    images: variant.images || [],
    inventory: variant.inventory || {},
    price: {
      base: price.base,
      sale: price.sale,
      ...(userType === 'wholesaler' && {
        wholesaleBase: variant.price?.wholesaleBase,
        wholesaleSale: variant.price?.wholesaleSale,
        minimumOrderQuantity: variant.minimumOrderQuantity
      })
    },
    isActive: variant.isActive,
    wholesale: variant.wholesale || false,
    minimumOrderQuantity: variant.minimumOrderQuantity || 1,
    // ✅ ADD VIRTUALS HERE
    isSaleActive: isSaleValidForVariant,
    finalPrice: currentPrice,
    discountPercentage: discountPercentage
  };
  
  // ✅ FULL PRODUCT OBJECT with variants array
  const fullProduct = {
    _id: product._id,
    name: product.name,
    slug: product.slug,
    title: product.title,
    description: product.description,
    brand: product.brand,
    category: product.category,
    seo: product.seo,
    soldInfo: product.soldInfo,
    fomo: product.fomo,
    hsnCode: product.hsnCode,
    taxRate: product.taxRate,
    isFragile: product.isFragile,
    shipping: product.shipping,
    attributes: product.attributes,
    isFeatured: product.isFeatured,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    variants: [fullVariant]
  };
  
  return {
    _id: item._id,
    productId: product._id,
    variantId: variant._id,
    quantity: item.quantity,
    price: {
      base: price.base,
      sale: price.sale,
      current: currentPrice,
      discountPercentage: discountPercentage,
      isSaleActive: isSaleValidForVariant
    },
    product: fullProduct,
    total: itemTotal
  };
};

// =============================================
// GET CART
// =============================================
const getCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';

  try {
    const cart = await Cart.findOne({ userId })
      .populate({ 
        path: 'items.productId', 
        select: 'name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants'
      }).lean();

    if (!cart) {
      return res.json({ 
        success: true, 
        cart: { items: [], totalAmount: 0 },
        userType: userType
      });
    }

    // ✅ Format each item with full data
    const itemsWithFullData = [];
    
    for (const item of cart.items) {
      const product = item.productId;
      if (!product) continue;
      
      let variant = null;
      if (item.variantId) {
        variant = product.variants?.find(v => String(v._id) === String(item.variantId));
      }
      
      if (!variant) {
        variant = product.variants?.find(v => v.isActive);
      }
      
      if (!variant) continue;
      
      const formattedItem = formatCartItem(item, product, variant, userType);
      if (formattedItem) {
        itemsWithFullData.push(formattedItem);
      }
    }
    
    // Calculate total
    const totalAmount = itemsWithFullData.reduce((sum, item) => sum + item.total, 0);
    
    // Calculate total discount
    const totalOriginalAmount = itemsWithFullData.reduce((sum, item) => {
      const originalPrice = item.price.base;
      return sum + (originalPrice * item.quantity);
    }, 0);
    
    const totalDiscount = totalOriginalAmount - totalAmount;
    const totalDiscountPercentage = totalOriginalAmount > 0 
      ? Math.round((totalDiscount / totalOriginalAmount) * 100)
      : 0;

    return res.json({
      success: true,
      cart: {
        _id: cart._id,
        userId: cart.userId,
        items: itemsWithFullData,
        totalAmount: totalAmount,
        totalOriginalAmount: totalOriginalAmount,
        totalDiscount: totalDiscount,
        totalDiscountPercentage: totalDiscountPercentage,
        createdAt: cart.createdAt,
        updatedAt: cart.updatedAt
      },
      userType: userType
    });

  } catch (err) {
    console.error('getCart:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// ADD TO CART
// =============================================
const addToCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const { productId, productSlug, variantId, quantity = 1 } = req.body;

  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized' 
    });
  }

  try {
    // Resolve product
    let product;
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      product = await Product.findById(productId).select('name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants');
    } else if (productSlug) {
      product = await Product.findOne({ 
        slug: String(productSlug).toLowerCase(), 
        status: 'active' 
      }).select('name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants');
    }

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }
    
    if (product.status !== 'active') {
      return res.status(400).json({ 
        success: false, 
        message: 'Product not active' 
      });
    }

    // Find variant
    let variant = null;
    
    if (variantId) {
      variant = findVariant(product, variantId);
      if (!variant) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid variantId. Variant not found or inactive.' 
        });
      }
    } else {
      variant = (product.variants || []).find(v => v.isActive) || null;
      if (!variant) {
        return res.status(404).json({ 
          success: false, 
          message: 'No active variant available for this product' 
        });
      }
    }

    // Check MOQ for wholesaler
    if (userType === 'wholesaler') {
      const moq = variant.minimumOrderQuantity || 1;
      if (quantity < moq) {
        return res.status(400).json({
          success: false,
          message: `Minimum order quantity for this product is ${moq}`
        });
      }
    }

    // Stock validation
    if (variant.inventory?.trackInventory) {
      const available = Number(variant.inventory.quantity || 0);
      if (available < quantity) {
        return res.status(400).json({ 
          success: false, 
          message: 'Insufficient stock for variant' 
        });
      }
    }

    // Prepare price snapshot based on userType
    const price = getUserSpecificPrice(variant, userType);
    
    const priceSnapshot = {
      base: price.base,
      sale: price.sale,
      costPrice: variant.price?.costPrice ?? null,
      saleStartDate: variant.price?.saleStartDate ?? null,
      saleEndDate: variant.price?.saleEndDate ?? null
    };

    const variantAttrSnapshot = (variant.attributes || []).map(a => ({ 
      key: a.key, 
      value: a.value 
    }));

    // Upsert cart and item
    let cart = await Cart.findOne({ userId });
    if (!cart) {
      cart = new Cart({ userId, items: [] });
    }

    // Check existing same item
    const existing = cart.items.find(it => 
      String(it.productId) === String(product._id) && 
      String(it.variantId) === String(variant._id)
    );
    
    if (existing) {
      const newQty = existing.quantity + Number(quantity);
      if (variant.inventory?.trackInventory) {
        if (variant.inventory.quantity < newQty) {
          return res.status(400).json({ 
            success: false, 
            message: 'Insufficient stock for requested quantity' 
          });
        }
      }
      existing.quantity = newQty;
      existing.priceSnapshot = priceSnapshot;
      existing.variantAttributesSnapshot = variantAttrSnapshot;
    } else {
      cart.items.push({ 
        productId: product._id, 
        variantId: variant._id, 
        quantity: Number(quantity), 
        priceSnapshot, 
        variantAttributesSnapshot: variantAttrSnapshot 
      });
    }

    cart.calculateTotal();
    await cart.save();

    // Return cart with full data
    const updatedCart = await Cart.findOne({ userId })
      .populate({ 
        path: 'items.productId', 
        select: 'name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants'
      });

    // Format response
    const formattedItems = [];
    for (const item of updatedCart.items) {
      const prod = item.productId;
      if (!prod) continue;
      
      let varObj = null;
      if (item.variantId) {
        varObj = prod.variants?.find(v => String(v._id) === String(item.variantId));
      }
      if (!varObj) {
        varObj = prod.variants?.find(v => v.isActive);
      }
      if (!varObj) continue;
      
      const formatted = formatCartItem(item, prod, varObj, userType);
      if (formatted) formattedItems.push(formatted);
    }
    
    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    return res.json({ 
      success: true, 
      cart: {
        _id: updatedCart._id,
        userId: updatedCart.userId,
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc,
        createdAt: updatedCart.createdAt,
        updatedAt: updatedCart.updatedAt
      },
      userType: userType
    });
    
  } catch (err) {
    console.error('addToCart:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// UPDATE CART ITEM
// =============================================
const updateCartItem = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const { productId, variantId, quantity } = req.body;

  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized' 
    });
  }
  
  if (!productId || !variantId) {
    return res.status(400).json({ 
      success: false, 
      message: 'productId and variantId required' 
    });
  }

  try {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.status(404).json({ 
        success: false, 
        message: 'Cart not found' 
      });
    }

    const item = cart.items.find(it => 
      String(it.productId) === String(productId) && 
      String(it.variantId) === String(variantId)
    );
    
    if (!item) {
      return res.status(404).json({ 
        success: false, 
        message: 'Item not in cart' 
      });
    }

    if (quantity <= 0) {
      cart.items = cart.items.filter(it => 
        !(String(it.productId) === String(productId) && 
          String(it.variantId) === String(variantId))
      );
      cart.calculateTotal();
      await cart.save();
      
      const updatedCart = await Cart.findOne({ userId })
        .populate({ 
          path: 'items.productId', 
          select: 'name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants'
        });
      
      // Format response
      const formattedItems = [];
      for (const it of updatedCart.items) {
        const prod = it.productId;
        if (!prod) continue;
        let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
        if (!varObj) varObj = prod.variants?.find(v => v.isActive);
        if (!varObj) continue;
        const formatted = formatCartItem(it, prod, varObj, userType);
        if (formatted) formattedItems.push(formatted);
      }
      
      const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
      const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
      const totalDisc = totalOriginalAmt - totalAmt;
      const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;
      
      return res.json({ 
        success: true, 
        cart: {
          ...updatedCart.toObject(),
          items: formattedItems,
          totalAmount: totalAmt,
          totalOriginalAmount: totalOriginalAmt,
          totalDiscount: totalDisc,
          totalDiscountPercentage: totalDiscPerc
        },
        userType: userType
      });
    }

    // Re-check live stock and pricing
    const product = await Product.findById(productId).select('variants name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt');
    const variant = findVariant(product, variantId);
    if (!variant) {
      return res.status(404).json({ 
        success: false, 
        message: 'Variant not found' 
      });
    }

    // Check MOQ for wholesaler
    if (userType === 'wholesaler') {
      const moq = variant.minimumOrderQuantity || 1;
      if (quantity < moq) {
        return res.status(400).json({
          success: false,
          message: `Minimum order quantity for this product is ${moq}`
        });
      }
    }

    if (variant.inventory?.trackInventory && variant.inventory.quantity < quantity) {
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient stock' 
      });
    }

    // Refresh price snapshot based on userType
    const price = getUserSpecificPrice(variant, userType);

    item.quantity = Number(quantity);
    item.priceSnapshot = {
      base: price.base,
      sale: price.sale,
      costPrice: variant.price?.costPrice ?? null,
      saleStartDate: variant.price?.saleStartDate ?? null,
      saleEndDate: variant.price?.saleEndDate ?? null
    };
    item.variantAttributesSnapshot = (variant.attributes || []).map(a => ({ 
      key: a.key, 
      value: a.value 
    }));

    cart.calculateTotal();
    await cart.save();

    // Populate for response
    const populatedCart = await Cart.findOne({ userId })
      .populate({ 
        path: 'items.productId', 
        select: 'name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants'
      });

    // Format response
    const formattedItems = [];
    for (const it of populatedCart.items) {
      const prod = it.productId;
      if (!prod) continue;
      let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
      if (!varObj) varObj = prod.variants?.find(v => v.isActive);
      if (!varObj) continue;
      const formatted = formatCartItem(it, prod, varObj, userType);
      if (formatted) formattedItems.push(formatted);
    }
    
    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    return res.json({ 
      success: true, 
      cart: {
        ...populatedCart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      },
      userType: userType
    });
    
  } catch (err) {
    console.error('updateCartItem:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// MERGE CART (Guest cart after login) - Simplified version
// =============================================
const mergeCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const { items } = req.body;

  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      message: "Unauthorized" 
    });
  }

  if (!Array.isArray(items)) {
    return res.status(400).json({ 
      success: false, 
      message: "Invalid items" 
    });
  }

  try {
    let cart = await Cart.findOne({ userId });
    if (!cart) cart = new Cart({ userId, items: [] });

    for (const incoming of items) {
      const { productId, variantId, quantity } = incoming;
      if (!productId || !variantId || quantity <= 0) continue;

      // Check if product exists
      const product = await Product.findById(productId).select('variants status');
      if (!product || product.status !== 'active') continue;

      const variant = product.variants.find(v => String(v._id) === String(variantId));
      if (!variant || !variant.isActive) continue;

      let qty = Number(quantity);
      if (qty <= 0) continue;

      const existing = cart.items.find(
        it => String(it.productId) === String(productId) && 
              String(it.variantId) === String(variantId)
      );

      if (existing) {
        existing.quantity += qty;
      } else {
        const price = getUserSpecificPrice(variant, userType);
        cart.items.push({
          productId,
          variantId,
          quantity: qty,
          priceSnapshot: {
            base: price.base,
            sale: price.sale,
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

    // Return updated cart
    const populatedCart = await Cart.findOne({ userId })
      .populate({ 
        path: 'items.productId', 
        select: 'name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants'
      });

    const formattedItems = [];
    for (const it of populatedCart?.items || []) {
      const prod = it.productId;
      if (!prod) continue;
      let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
      if (!varObj) varObj = prod.variants?.find(v => v.isActive);
      if (!varObj) continue;
      const formatted = formatCartItem(it, prod, varObj, userType);
      if (formatted) formattedItems.push(formatted);
    }

    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    return res.json({ 
      success: true, 
      cart: populatedCart ? {
        ...populatedCart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      } : { items: [], totalAmount: 0 },
      userType: userType
    });

  } catch (err) {
    console.error("mergeCart error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Merge failed",
      error: err.message 
    });
  }
};

// =============================================
// REMOVE SINGLE ITEM FROM CART
// =============================================
const removeCartItem = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const { productId, variantId } = req.body;

  try {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.status(404).json({ 
        success: false, 
        message: 'Cart not found' 
      });
    }

    cart.items = cart.items.filter(it =>
      !(String(it.productId) === String(productId) &&
        String(it.variantId) === String(variantId))
    );

    cart.calculateTotal();
    await cart.save();

    const populatedCart = await Cart.findOne({ userId })
      .populate({ 
        path: 'items.productId', 
        select: 'name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants'
      });

    const formattedItems = [];
    if (populatedCart) {
      for (const it of populatedCart.items) {
        const prod = it.productId;
        if (!prod) continue;
        let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
        if (!varObj) varObj = prod.variants?.find(v => v.isActive);
        if (!varObj) continue;
        const formatted = formatCartItem(it, prod, varObj, userType);
        if (formatted) formattedItems.push(formatted);
      }
    }

    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    res.json({ 
      success: true, 
      cart: populatedCart ? {
        ...populatedCart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      } : { items: [], totalAmount: 0 },
      userType: userType
    });
    
  } catch (err) {
    console.error('removeCartItem:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// BULK REMOVE FROM CART
// =============================================
const bulkRemove = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const { items } = req.body;

  try {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.status(404).json({ 
        success: false, 
        message: 'Cart not found' 
      });
    }

    cart.items = cart.items.filter(it =>
      !items.some(rem =>
        String(rem.productId) === String(it.productId) &&
        String(rem.variantId) === String(it.variantId)
      )
    );

    cart.calculateTotal();
    await cart.save();

    const populatedCart = await Cart.findOne({ userId })
      .populate({ 
        path: 'items.productId', 
        select: 'name slug title description brand category seo soldInfo fomo hsnCode taxRate isFragile shipping attributes isFeatured status createdAt updatedAt variants'
      });

    const formattedItems = [];
    if (populatedCart) {
      for (const it of populatedCart.items) {
        const prod = it.productId;
        if (!prod) continue;
        let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
        if (!varObj) varObj = prod.variants?.find(v => v.isActive);
        if (!varObj) continue;
        const formatted = formatCartItem(it, prod, varObj, userType);
        if (formatted) formattedItems.push(formatted);
      }
    }

    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    res.json({ 
      success: true, 
      cart: populatedCart ? {
        ...populatedCart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      } : { items: [], totalAmount: 0 },
      userType: userType
    });
    
  } catch (err) {
    console.error('bulkRemove:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// CLEAR CART
// =============================================
const clearCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';

  try {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.json({ 
        success: true, 
        message: 'Cart already empty',
        cart: { items: [], totalAmount: 0 },
        userType: userType
      });
    }

    cart.items = [];
    cart.totalAmount = 0;
    await cart.save();

    return res.json({
      success: true,
      message: 'Cart cleared successfully',
      cart: { items: [], totalAmount: 0 },
      userType: userType
    });

  } catch (err) {
    console.error('clearCart:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

module.exports = { 
  addToCart, 
  updateCartItem, 
  mergeCart, 
  getCart, 
  removeCartItem, 
  bulkRemove,
  clearCart
};