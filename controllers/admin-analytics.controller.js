// controllers/admin-analytics.controller.js
const User = require('../models/User');
const cart = require('../models/cart');
const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const mongoose = require('mongoose');

// =============================================
// 1. GET ALL USERS (READ ONLY)
// =============================================
const getAllUsers = async (req, res) => {
  try {
    let { page = 1, limit = 20, search = '', role = '' } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    const skip = (page - 1) * limit;

    // Build query
    let query = {};
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (role && ['user', 'wholesaler', 'admin'].includes(role)) {
      query.role = role;
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('-password -refreshToken') // Exclude sensitive data
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);

    // Get additional stats for each user
    const usersWithStats = await Promise.all(users.map(async (user) => {
      // Get cart count
      const cart = await cart.findOne({ userId: user._id });
      const cartItemsCount = cart?.items?.length || 0;
      
      // Get wishlist count
      const wishlist = await Wishlist.findOne({ userId: user._id });
      const wishlistCount = wishlist?.products?.length || 0;
      
      return {
        ...user,
        cartItemsCount,
        wishlistCount,
        lastActive: user.updatedAt || user.createdAt
      };
    }));

    return res.status(200).json({
      success: true,
      data: usersWithStats,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get all users error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching users',
      error: error.message
    });
  }
};

// =============================================
// 2. GET USER DETAILS BY ID (READ ONLY)
// =============================================
const           getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    const user = await User.findById(userId)
      .select('-password -refreshToken')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get cart details
    const cart = await cart.findOne({ userId: user._id })
      .populate('items.productId', 'name slug images')
      .lean();

    // Get wishlist details
    const wishlist = await Wishlist.findOne({ userId: user._id })
      .populate('products.productId', 'name slug price variants')
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        user,
        cart: cart || { items: [], totalAmount: 0 },
        wishlist: wishlist || { products: [] }
      }
    });

  } catch (error) {
    console.error('Get user by ID error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching user details',
      error: error.message
    });
  }
};


// =============================================
// 3. GET ALL CARTS WITH ANALYTICS
// =============================================
const getAllcarts = async (req, res) => {
  try {
    let { page = 1, limit = 20, sortBy = 'createdAt', order = 'desc' } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    const skip = (page - 1) * limit;

    const sortOrder = order === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const [carts, total] = await Promise.all([
      cart.find()
        .populate('userId', 'name email phone role')
        .populate('items.productId', 'name slug images')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      cart.countDocuments()
    ]);

    // Format carts data
    const formattedcarts = carts.map(cart => ({
      _id: cart._id,
      user: cart.userId,
      items: cart.items.map(item => ({
        productId: item.productId?._id,
        productName: item.productId?.name,
        variantId: item.variantId,
        quantity: item.quantity,
        priceSnapshot: item.priceSnapshot,
        variantAttributes: item.variantAttributesSnapshot,
        addedAt: item.createdAt
      })),
      totalAmount: cart.totalAmount,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
      itemCount: cart.items.length
    }));

    return res.status(200).json({
      success: true,
      data: formattedcarts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get all carts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching carts',
      error: error.message
    });
  }
};

// =============================================
// 4. GET ABANDONED CARTS (Not purchased, older than X hours)
// =============================================
const getAbandonedcarts = async (req, res) => {
  try {
    let { page = 1, limit = 20, hours = 24 } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    hours = Math.max(1, Number(hours));
    const skip = (page - 1) * limit;

    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - hours);

    // Find carts older than cutoff date with items
    const carts = await cart.find({
      updatedAt: { $lt: cutoffDate },
      'items.0': { $exists: true } // Has at least one item
    })
      .populate('userId', 'name email phone')
      .populate('items.productId', 'name slug price')
      .sort({ updatedAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await cart.countDocuments({
      updatedAt: { $lt: cutoffDate },
      'items.0': { $exists: true }
    });

    const formattedcarts = carts.map(cart => ({
      _id: cart._id,
      user: cart.userId,
      items: cart.items.map(item => ({
        productId: item.productId?._id,
        productName: item.productId?.name,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.priceSnapshot?.sale || item.priceSnapshot?.base
      })),
      totalAmount: cart.totalAmount,
      abandonedSince: cart.updatedAt,
      hoursSinceUpdate: Math.floor((Date.now() - new Date(cart.updatedAt)) / (1000 * 60 * 60)),
      itemCount: cart.items.length
    }));

    return res.status(200).json({
      success: true,
      data: formattedcarts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        criteria: `Abandoned for > ${hours} hours`
      }
    });

  } catch (error) {
    console.error('Get abandoned carts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching abandoned carts',
      error: error.message
    });
  }
};

// =============================================
// 5. GET CARTS WITH HIGH VALUE (Above threshold)
// =============================================
const getHighValuecarts = async (req, res) => {
  try {
    let { page = 1, limit = 20, minAmount = 5000 } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    minAmount = Math.max(0, Number(minAmount));
    const skip = (page - 1) * limit;

    const carts = await cart.find({
      totalAmount: { $gte: minAmount },
      'items.0': { $exists: true }
    })
      .populate('userId', 'name email phone')
      .populate('items.productId', 'name slug')
      .sort({ totalAmount: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await cart.countDocuments({
      totalAmount: { $gte: minAmount },
      'items.0': { $exists: true }
    });

    return res.status(200).json({
      success: true,
      data: carts.map(cart => ({
        _id: cart._id,
        user: cart.userId,
        itemsCount: cart.items.length,
        totalAmount: cart.totalAmount,
        createdAt: cart.createdAt,
        updatedAt: cart.updatedAt
      })),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        criteria: `cart value ≥ ₹${minAmount}`
      }
    });

  } catch (error) {
    console.error('Get high value carts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching high value carts',
      error: error.message
    });
  }
};

// =============================================
// 6. GET ALL WISHLISTS
// =============================================
const getAllWishlists = async (req, res) => {
  try {
    let { page = 1, limit = 20, sortBy = 'createdAt', order = 'desc' } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    const skip = (page - 1) * limit;

    const sortOrder = order === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const [wishlists, total] = await Promise.all([
      Wishlist.find()
        .populate('userId', 'name email phone role')
        .populate('products.productId', 'name slug images price')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Wishlist.countDocuments()
    ]);

    const formattedWishlists = wishlists.map(wishlist => ({
      _id: wishlist._id,
      user: wishlist.userId,
      products: wishlist.products.map(p => ({
        productId: p.productId?._id,
        productName: p.productId?.name,
        variantId: p.variantId,
        addedAt: p.addedAt,
        price: p.productId?.price?.sale || p.productId?.price?.base
      })),
      createdAt: wishlist.createdAt,
      updatedAt: wishlist.updatedAt,
      itemCount: wishlist.products.length
    }));

    return res.status(200).json({
      success: true,
      data: formattedWishlists,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get all wishlists error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching wishlists',
      error: error.message
    });
  }
};

// =============================================
// 7. GET STALE WISHLISTS (Items added X days ago, not purchased)
// =============================================
const getStaleWishlists = async (req, res) => {
  try {
    let { page = 1, limit = 20, days = 7 } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    days = Math.max(1, Number(days));
    const skip = (page - 1) * limit;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Find wishlists with products added before cutoff date
    const wishlists = await Wishlist.find({
      'products.addedAt': { $lt: cutoffDate },
      'products.0': { $exists: true }
    })
      .populate('userId', 'name email phone')
      .populate('products.productId', 'name slug price')
      .sort({ 'products.addedAt': 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Wishlist.countDocuments({
      'products.addedAt': { $lt: cutoffDate },
      'products.0': { $exists: true }
    });

    const formattedWishlists = wishlists.map(wishlist => {
      // Get oldest product in wishlist
      const oldestProduct = wishlist.products.reduce((oldest, p) => 
        p.addedAt < oldest.addedAt ? p : oldest, wishlist.products[0]);
      
      return {
        _id: wishlist._id,
        user: wishlist.userId,
        products: wishlist.products.map(p => ({
          productId: p.productId?._id,
          productName: p.productId?.name,
          variantId: p.variantId,
          addedAt: p.addedAt,
          daysSinceAdded: Math.floor((Date.now() - new Date(p.addedAt)) / (1000 * 60 * 60 * 24))
        })),
        oldestItemAddedAt: oldestProduct.addedAt,
        daysSinceOldestItem: Math.floor((Date.now() - new Date(oldestProduct.addedAt)) / (1000 * 60 * 60 * 24)),
        itemCount: wishlist.products.length,
        createdAt: wishlist.createdAt
      };
    });

    return res.status(200).json({
      success: true,
      data: formattedWishlists,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        criteria: `Items added > ${days} days ago`
      }
    });

  } catch (error) {
    console.error('Get stale wishlists error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching stale wishlists',
      error: error.message
    });
  }
};

// =============================================
// 8. GET WISHLISTS WITH MOST POPULAR PRODUCTS
// =============================================
const getPopularWishlistProducts = async (req, res) => {
  try {
    let { limit = 20 } = req.query;
    limit = Math.min(50, Math.max(1, Number(limit)));

    const wishlists = await Wishlist.find({ 'products.0': { $exists: true } })
      .populate('products.productId', 'name slug price images')
      .lean();

    // Count product popularity
    const productCount = {};
    
    for (const wishlist of wishlists) {
      for (const product of wishlist.products) {
        const productId = product.productId?._id?.toString();
        if (productId) {
          productCount[productId] = (productCount[productId] || 0) + 1;
        }
      }
    }

    // Sort and format
    const popularProducts = Object.entries(productCount)
      .map(([productId, count]) => {
        const product = wishlists.find(w => 
          w.products.some(p => p.productId?._id?.toString() === productId)
        )?.products.find(p => p.productId?._id?.toString() === productId)?.productId;
        
        return {
          productId,
          productName: product?.name,
          wishlistCount: count,
          price: product?.price?.sale || product?.price?.base
        };
      })
      .sort((a, b) => b.wishlistCount - a.wishlistCount)
      .slice(0, limit);

    return res.status(200).json({
      success: true,
      data: popularProducts,
      totalProducts: Object.keys(productCount).length
    });

  } catch (error) {
    console.error('Get popular wishlist products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching popular products',
      error: error.message
    });
  }
};

// =============================================
// 9. DASHBOARD SUMMARY (Admin Dashboard)
// =============================================
const getDashboardSummary = async (req, res) => {
  try {
    // Get counts
    const [
      totalUsers,
      totalWholesalers,
      totalcarts,
      totalWishlists,
      abandonedcarts24h,
      staleWishlists7d
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: 'wholesaler' }),
      cart.countDocuments({ 'items.0': { $exists: true } }),
      Wishlist.countDocuments({ 'products.0': { $exists: true } }),
      
      // Abandoned carts (>24 hours)
      cart.countDocuments({
        updatedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        'items.0': { $exists: true }
      }),
      
      // Stale wishlists (>7 days)
      Wishlist.countDocuments({
        'products.addedAt': { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        'products.0': { $exists: true }
      })
    ]);

    // Get total cart value
    const cartAggregation = await cart.aggregate([
      { $match: { 'items.0': { $exists: true } } },
      { $group: { _id: null, totalValue: { $sum: '$totalAmount' } } }
    ]);
    const totalcartValue = cartAggregation[0]?.totalValue || 0;

    // Get average cart value
    const avgcartValue = totalcarts > 0 ? totalcartValue / totalcarts : 0;

    return res.status(200).json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          wholesalers: totalWholesalers,
          regular: totalUsers - totalWholesalers
        },
        carts: {
          total: totalcarts,
          totalValue: totalcartValue,
          averageValue: avgcartValue,
          abandoned24h: abandonedcarts24h
        },
        wishlists: {
          total: totalWishlists,
          stale7d: staleWishlists7d
        },
        timestamp: new Date()
      }
    });

  } catch (error) {
    console.error('Get dashboard summary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching dashboard summary',
      error: error.message
    });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  getAllCarts: getAllcarts,
  getAbandonedCarts: getAbandonedcarts,
  getHighValueCarts: getHighValuecarts,
  getAllWishlists,
  getStaleWishlists,
  getPopularWishlistProducts,
  getDashboardSummary
};