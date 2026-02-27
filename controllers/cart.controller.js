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

// ADD TO CART
// body: { productId | productSlug, variantId?, quantity }
const addToCart = async (req, res) => {
  const userId = req.userId;
  const { productId, productSlug, variantId, quantity = 1 } = req.body;

  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  try {
    // Resolve product
    let product;
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      product = await Product.findById(productId).select('variants status name slug');
    } else if (productSlug) {
      product = await Product.findOne({ slug: String(productSlug).toLowerCase(), status: 'active' }).select('variants status name slug');
    }

    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    if (product.status !== 'active') return res.status(400).json({ success: false, message: 'Product not active' });

    // Resolve variant
    let variant = null;
    if (variantId) variant = findVariant(product, variantId);
    if (!variant) {
      variant = (product.variants || []).find(v => v.isActive) || null;
    }

    if (!variant) return res.status(404).json({ success: false, message: 'Variant not available' });

    // Stock validation
    if (variant.inventory?.trackInventory) {
      const available = Number(variant.inventory.quantity || 0);
      if (available < quantity) return res.status(400).json({ success: false, message: 'Insufficient stock for variant' });
    }

    // Prepare price snapshot
    const priceSnapshot = {
      base: variant.price?.base ?? 0,
      sale: variant.price?.sale ?? null,
      costPrice: variant.price?.costPrice ?? null,
      saleStartDate: variant.price?.saleStartDate ?? null,
      saleEndDate: variant.price?.saleEndDate ?? null
    };

    const variantAttrSnapshot = (variant.attributes || []).map(a => ({ key: a.key, value: a.value }));

    // Upsert cart and item
    let cart = await Cart.findOne({ userId });
    if (!cart) {
      cart = new Cart({ userId, items: [] });
    }

    // Check existing same item
    const existing = cart.items.find(it => String(it.productId) === String(product._id) && String(it.variantId) === String(variant._id));
    if (existing) {
      // validate cumulative quantity
      const newQty = existing.quantity + Number(quantity);
      if (variant.inventory?.trackInventory) {
        if (variant.inventory.quantity < newQty) return res.status(400).json({ success: false, message: 'Insufficient stock for requested quantity' });
      }
      existing.quantity = newQty;
      existing.priceSnapshot = priceSnapshot;
      existing.variantAttributesSnapshot = variantAttrSnapshot;
    } else {
      cart.items.push({ productId: product._id, variantId: variant._id, quantity: Number(quantity), priceSnapshot, variantAttributesSnapshot: variantAttrSnapshot });
    }

    cart.calculateTotal();
    await cart.save();

    return res.json({ success: true, cart });
  } catch (err) {
    console.error('addToCart:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// UPDATE CART ITEM: change quantity or remove
// body: { productId, variantId, quantity }
const updateCartItem = async (req, res) => {
  const userId = req.userId;
  const { productId, variantId, quantity } = req.body;

  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!productId || !variantId) return res.status(400).json({ success: false, message: 'productId and variantId required' });

  try {
    const cart = await Cart.findOne({ userId });
    if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

    const item = cart.items.find(it => String(it.productId) === String(productId) && String(it.variantId) === String(variantId));
    if (!item) return res.status(404).json({ success: false, message: 'Item not in cart' });

    if (quantity <= 0) {
      // remove
      cart.items = cart.items.filter(it => !(String(it.productId) === String(productId) && String(it.variantId) === String(variantId)));
      cart.calculateTotal();
      await cart.save();
      return res.json({ success: true, cart });
    }

    // Re-check live stock
    const product = await Product.findById(productId).select('variants');
    const variant = findVariant(product, variantId);
    if (!variant) return res.status(404).json({ success: false, message: 'Variant not found' });

    if (variant.inventory?.trackInventory && variant.inventory.quantity < quantity) return res.status(400).json({ success: false, message: 'Insufficient stock' });

    item.quantity = Number(quantity);
    // refresh snapshot price to current
    item.priceSnapshot = {
      base: variant.price?.base ?? 0,
      sale: variant.price?.sale ?? null,
      costPrice: variant.price?.costPrice ?? null,
      saleStartDate: variant.price?.saleStartDate ?? null,
      saleEndDate: variant.price?.saleEndDate ?? null
    };
    item.variantAttributesSnapshot = (variant.attributes || []).map(a => ({ key: a.key, value: a.value }));

    cart.calculateTotal();
    await cart.save();

    return res.json({ success: true, cart });
  } catch (err) {
    console.error('updateCartItem:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};


const mergeCart = async (req, res) => {
  const userId = req.userId;
  const { items } = req.body;

  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!Array.isArray(items)) return res.status(400).json({ success: false, message: 'Invalid items' });

  try {
    let cart = await Cart.findOne({ userId });
    if (!cart) cart = new Cart({ userId, items: [] });

    for (const incoming of items) {
      const { productId, variantId, quantity } = incoming;

      const product = await Product.findById(productId).select('variants status');
      if (!product || product.status !== 'active') continue;

      const variant = product.variants.find(v => String(v._id) === String(variantId));
      if (!variant || !variant.isActive) continue;

      const existing = cart.items.find(it =>
        String(it.productId) === String(productId) &&
        String(it.variantId) === String(variantId)
      );

      if (existing) {
        existing.quantity += Number(quantity);
      } else {
        cart.items.push({
          productId,
          variantId,
          quantity: Number(quantity),
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

    return res.json({ success: true, cart });

  } catch (err) {
    console.error('mergeCart:', err);
    return res.status(500).json({ success: false, message: 'Merge failed' });
  }
};


//Remove single item from cart
const removeCartItem = async (req, res) => {
  const userId = req.userId;
  const { productId, variantId } = req.body;

  const cart = await Cart.findOne({ userId });
  if (!cart) return res.status(404).json({ success: false });

  cart.items = cart.items.filter(it =>
    !(String(it.productId) === String(productId) &&
      String(it.variantId) === String(variantId))
  );

  cart.calculateTotal();
  await cart.save();

  res.json({ success: true, cart });
};


//Bulk remove from cart
const bulkRemove = async (req, res) => {
  const userId = req.userId;
  const { items } = req.body; 
  // items = [{productId, variantId}]

  const cart = await Cart.findOne({ userId });
  if (!cart) return res.status(404).json({ success: false });

  cart.items = cart.items.filter(it =>
    !items.some(rem =>
      String(rem.productId) === String(it.productId) &&
      String(rem.variantId) === String(it.variantId)
    )
  );

  cart.calculateTotal();
  await cart.save();

  res.json({ success: true, cart });
};



// CHECKOUT: create order, deduct stock from variants atomically
// body: { paymentInfo? }
const checkout = async (req, res) => {
  const userId = req.userId;
  const { paymentInfo } = req.body;

  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const cart = await Cart.findOne({ userId }).session(session);
    if (!cart || !cart.items.length) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Cart empty' });
    }

    // Re-validate stock and build order items
    const orderItems = [];
    let totalAmount = 0;

    for (const it of cart.items) {
      const product = await Product.findById(it.productId).session(session).select('variants');
      if (!product) throw new Error('Product not found during checkout');

      const variant = findVariant(product, it.variantId);
      if (!variant) throw new Error('Variant not found during checkout');

      if (variant.inventory?.trackInventory) {
        if (variant.inventory.quantity < it.quantity) throw new Error(`Insufficient stock for SKU ${variant.sku}`);
      }

      const priceSnapshot = {
        base: variant.price?.base ?? 0,
        sale: variant.price?.sale ?? null,
        costPrice: variant.price?.costPrice ?? null,
        saleStartDate: variant.price?.saleStartDate ?? null,
        saleEndDate: variant.price?.saleEndDate ?? null
      };

      const saleValid = isSaleValid(priceSnapshot);
      const unit = saleValid ? priceSnapshot.sale : priceSnapshot.base;
      totalAmount += unit * it.quantity;

      orderItems.push({ productId: it.productId, variantId: it.variantId, quantity: it.quantity, priceSnapshot, variantAttributesSnapshot: it.variantAttributesSnapshot });

      // Deduct stock atomically from the specific variant
      if (variant.inventory?.trackInventory) {
        const updateResult = await Product.updateOne(
          { _id: product._id, 'variants._id': variant._id, 'variants.inventory.quantity': { $gte: it.quantity } },
          { $inc: { 'variants.$.inventory.quantity': -it.quantity } }
        ).session(session);

        if (updateResult.nModified === 0 && updateResult.modifiedCount === 0) {
          throw new Error(`Failed to deduct stock for SKU ${variant.sku}`);
        }
      }
    }

    // Create order
    const order = new Order({ userId, items: orderItems, totalAmount, status: 'pending', paymentInfo });
    await order.save({ session });

    // Clear cart
    cart.items = [];
    cart.totalAmount = 0;
    await cart.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.json({ success: true, order });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('checkout error:', err);
    return res.status(400).json({ success: false, message: err.message || 'Checkout failed' });
  }
};


const getCart = async (req, res) => {
  const userId = req.userId;

  try {
    const cart = await Cart.findOne({ userId })
      .populate('items.productId', 'name slug images status');

    if (!cart) {
      return res.json({ success: true, cart: { items: [], totalAmount: 0 } });
    }

    return res.json({ success: true, cart });

  } catch (err) {
    console.error('getCart:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { addToCart, updateCartItem, checkout, mergeCart, getCart, removeCartItem, bulkRemove };
