
const mongoose = require('mongoose');
const Cart = require('../models/cart');
const Product = require('../models/Product');
const Order = require('../models/Order');

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

// GET CART
const getCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';

  try {
    const cart = await Cart.findOne({ userId })
      .populate({ path: 'items.productId', select: 'name slug images variants' });

    if (!cart) {
      return res.json({ 
        success: true, 
        cart: { items: [], totalAmount: 0 },
        userType: userType
      });
    }

    // Add userType pricing to cart items
    const itemsWithPricing = cart.items.map(item => {
      const product = item.productId;
      let variant = null;
      
      if (item.variantId) {
        variant = product?.variants?.find(v => String(v._id) === String(item.variantId));
      }
      
      // Calculate current price based on userType
      let currentPrice = 0;
      let basePrice = 0;
      let salePrice = null;
      
      if (userType === 'wholesaler') {
        basePrice = variant?.price?.wholesaleBase || variant?.price?.base || 0;
        salePrice = variant?.price?.wholesaleSale || variant?.price?.wholesaleBase || basePrice;
        currentPrice = salePrice || basePrice;
      } else {
        basePrice = variant?.price?.base || 0;
        salePrice = variant?.price?.sale || null;
        
        // Check if sale is valid
        const now = new Date();
        const isSaleValid = salePrice && salePrice < basePrice &&
          (!variant?.price?.saleStartDate || now >= variant.price.saleStartDate) &&
          (!variant?.price?.saleEndDate || now <= variant.price.saleEndDate);
        
        currentPrice = isSaleValid ? salePrice : basePrice;
      }
      
      const itemTotal = currentPrice * item.quantity;
      
      return {
        _id: item._id,
        productId: item.productId._id,
        variantId: item.variantId,
        quantity: item.quantity,
        price: {
          base: basePrice,
          sale: salePrice,
          current: currentPrice
        },
        product: {
          _id: product._id,
          name: product.name,
          slug: product.slug,
          images: product.images
        },
        variant: variant ? {
          _id: variant._id,
          sku: variant.sku,
          attributes: variant.attributes,
          inventory: variant.inventory
        } : null,
        total: itemTotal
      };
    });
    
    // Recalculate total with current prices
    const totalAmount = itemsWithPricing.reduce((sum, item) => sum + item.total, 0);

    return res.json({
      success: true,
      cart: {
        _id: cart._id,
        userId: cart.userId,
        items: itemsWithPricing,
        totalAmount: totalAmount,
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

// ADD TO CART - FIXED VERSION
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
      product = await Product.findById(productId).select('variants status name slug');
    } else if (productSlug) {
      product = await Product.findOne({ 
        slug: String(productSlug).toLowerCase(), 
        status: 'active' 
      }).select('variants status name slug');
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

    // ✅ FIXED: Strict variant validation
    let variant = null;
    
    if (variantId) {
      // If variantId provided, MUST find exact match
      variant = findVariant(product, variantId);
      if (!variant) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid variantId. Variant not found or inactive.' 
        });
      }
    } else {
      // If no variantId provided, use first active variant
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

    // Return cart with updated pricing
    const updatedCart = await Cart.findOne({ userId })
      .populate('items.productId', 'name slug images');

    return res.json({ 
      success: true, 
      cart: updatedCart,
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
// UPDATE CART ITEM
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
        .populate('items.productId', 'name slug images');
      return res.json({ success: true, cart: updatedCart });
    }

    // Re-check live stock and pricing
    const product = await Product.findById(productId).select('variants');
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
      .populate('items.productId', 'name slug images');

    return res.json({ 
      success: true, 
      cart: populatedCart,
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

// MERGE CART (Guest cart after login)
// MERGE CART (Guest cart after login) - FIXED
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

  // ✅ If no items to merge, just return current cart
  if (items.length === 0) {
    const cart = await Cart.findOne({ userId }).populate('items.productId', 'name slug images');
    return res.json({ 
      success: true, 
      cart: cart || { items: [], totalAmount: 0 },
      userType: userType 
    });
  }

  try {
    let cart = await Cart.findOne({ userId });
    if (!cart) cart = new Cart({ userId, items: [] });

    // ✅ Log for debugging
    console.log('📦 Merge Cart - Current cart items:', cart.items.length);
    console.log('📦 Merge Cart - Incoming items:', items.length);

    // normalize duplicates
    const mergedMap = {};

    for (const item of items) {
      const key = `${item.productId}_${item.variantId}`;
      if (!mergedMap[key]) {
        mergedMap[key] = { ...item };
      } else {
        mergedMap[key].quantity += Number(item.quantity);
      }
    }

    const normalizedItems = Object.values(mergedMap);

    // fetch all products in one query
    const productIds = normalizedItems.map(i => i.productId);
    console.log('🔍 Looking for products with IDs:', productIds);

    const products = await Product.find({
      _id: { $in: productIds },
      status: 'active'  // ✅ Only active products
    }).select('variants');

    console.log('✅ Found products:', products.length);

    const productMap = new Map();
    products.forEach(product => {
      productMap.set(String(product._id), product);
    });

    let itemsAdded = 0;

    for (const incoming of normalizedItems) {
      const { productId, variantId, quantity } = incoming;

      const product = productMap.get(String(productId));
      if (!product) {
        console.log(`❌ Product not found or inactive: ${productId}`);
        continue;
      }

      const variant = product.variants.find(
        v => String(v._id) === String(variantId)
      );

      if (!variant || !variant.isActive) {
        console.log(`❌ Variant not found or inactive: ${variantId}`);
        continue;
      }

      let qty = Number(quantity);
      if (qty <= 0) continue;

      // Check MOQ for wholesaler
      if (userType === 'wholesaler') {
        const moq = variant.minimumOrderQuantity || 1;
        if (qty < moq) {
          qty = moq;
          console.log(`⚠️ Adjusted quantity to MOQ: ${moq}`);
        }
      }

      if (qty > variant.inventory.quantity) {
        qty = variant.inventory.quantity;
        console.log(`⚠️ Adjusted quantity to available stock: ${qty}`);
      }

      // Get user-specific pricing
      const price = getUserSpecificPrice(variant, userType);
      
      const existing = cart.items.find(
        it =>
          String(it.productId) === String(productId) &&
          String(it.variantId) === String(variantId)
      );

      if (existing) {
        existing.quantity += qty;
        if (existing.quantity > variant.inventory.quantity) {
          existing.quantity = variant.inventory.quantity;
        }
        existing.priceSnapshot = {
          base: price.base,
          sale: price.sale,
          costPrice: variant.price?.costPrice ?? null,
          saleStartDate: variant.price?.saleStartDate ?? null,
          saleEndDate: variant.price?.saleEndDate ?? null
        };
        console.log(`✅ Updated existing item, new quantity: ${existing.quantity}`);
      } else {
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
        itemsAdded++;
        console.log(`✅ Added new item, quantity: ${qty}`);
      }
    }

    cart.calculateTotal();
    await cart.save();

    console.log(`📦 Merge complete - Added ${itemsAdded} new items, Total items: ${cart.items.length}`);

    const populatedCart = await Cart.findOne({ userId })
      .populate('items.productId', 'name slug images');

    return res.json({ 
      success: true, 
      message: `${itemsAdded} item(s) merged from guest cart`,
      cart: populatedCart,
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

// REMOVE SINGLE ITEM FROM CART
const removeCartItem = async (req, res) => {
  const userId = req.userId;
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
      .populate('items.productId', 'name slug images');

    res.json({ 
      success: true, 
      cart: populatedCart 
    });
    
  } catch (err) {
    console.error('removeCartItem:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// BULK REMOVE FROM CART
const bulkRemove = async (req, res) => {
  const userId = req.userId;
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
      .populate('items.productId', 'name slug images');

    res.json({ 
      success: true, 
      cart: populatedCart 
    });
    
  } catch (err) {
    console.error('bulkRemove:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// CLEAR CART
const clearCart = async (req, res) => {
  const userId = req.userId;

  try {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.json({ 
        success: true, 
        message: 'Cart already empty',
        cart: { items: [], totalAmount: 0 }
      });
    }

    cart.items = [];
    cart.totalAmount = 0;
    await cart.save();

    return res.json({
      success: true,
      message: 'Cart cleared successfully',
      cart: { items: [], totalAmount: 0 }
    });

  } catch (err) {
    console.error('clearCart:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// CHECKOUT
const checkout = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const { paymentInfo } = req.body;

  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized' 
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const cart = await Cart.findOne({ userId }).session(session);
    if (!cart || !cart.items.length) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false, 
        message: 'Cart empty' 
      });
    }

    // Re-validate stock and build order items
    const orderItems = [];
    let subtotal = 0;

    for (const it of cart.items) {
      const product = await Product.findById(it.productId)
        .session(session)
        .select('variants');
      if (!product) throw new Error('Product not found during checkout');

      const variant = findVariant(product, it.variantId);
      if (!variant) throw new Error('Variant not found during checkout');

      // Check MOQ for wholesaler
      if (userType === 'wholesaler') {
        const moq = variant.minimumOrderQuantity || 1;
        if (it.quantity < moq) {
          throw new Error(`Minimum order quantity for ${variant.sku} is ${moq}`);
        }
      }

      // Stock validation
      if (variant.inventory?.trackInventory) {
        if (variant.inventory.quantity < it.quantity) {
          throw new Error(`Insufficient stock for SKU ${variant.sku}`);
        }
      }

      // Get user-specific pricing
      const price = getUserSpecificPrice(variant, userType);
      
      const priceSnapshot = {
        base: price.base,
        sale: price.sale
      };

      const saleValid = isSaleValid(priceSnapshot);
      const unit = saleValid ? priceSnapshot.sale : priceSnapshot.base;
      const itemTotal = unit * it.quantity;
      subtotal += itemTotal;

      orderItems.push({ 
        productId: it.productId, 
        variantId: it.variantId, 
        quantity: it.quantity, 
        priceSnapshot, 
        variantAttributesSnapshot: it.variantAttributesSnapshot,
        userType: userType  // Store userType with order item
      });

      // Deduct stock atomically from the specific variant
      if (variant.inventory?.trackInventory) {
        const updateResult = await Product.updateOne(
          { 
            _id: product._id, 
            'variants._id': variant._id, 
            'variants.inventory.quantity': { $gte: it.quantity } 
          },
          { $inc: { 'variants.$.inventory.quantity': -it.quantity } }
        ).session(session);

        if (updateResult.nModified === 0 && updateResult.modifiedCount === 0) {
          throw new Error(`Failed to deduct stock for SKU ${variant.sku}`);
        }
      }
    }

    // Create order (will be handled by order controller)
    const order = new Order({ 
      userId, 
      items: orderItems, 
      totalAmount: subtotal, 
      orderStatus: 'pending', 
      paymentStatus: 'pending',
      paymentInfo,
      userType: userType
    });
    await order.save({ session });

    // Clear cart
    cart.items = [];
    cart.totalAmount = 0;
    await cart.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.json({ 
      success: true, 
      order: {
        orderId: order.orderId,
        totalAmount: order.totalAmount,
        userType: userType
      }
    });
    
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('checkout error:', err);
    return res.status(400).json({ 
      success: false, 
      message: err.message || 'Checkout failed' 
    });
  }
};

module.exports = { 
  addToCart, 
  updateCartItem, 
  checkout, 
  mergeCart, 
  getCart, 
  removeCartItem, 
  bulkRemove,
  clearCart
};