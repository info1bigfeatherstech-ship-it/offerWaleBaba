// controllers/userProductController.js
const Product = require('../models/Product');
const Category = require('../models/Category');

// ✅ ADD THESE 2 LINES AT THE TOP
const cacheService = require('../services/cache.service');
const cacheConfig = require('../config/cache.config');

// ✅ ONLY PRICE LOGIC - Baaki sab same
const getVariantPrice = (variant, userType) => {
  if (userType === 'wholesaler') {
    return {
      base: variant.price.wholesaleBase || variant.price.base,
      sale: variant.price.wholesaleSale || variant.price.wholesaleBase || variant.price.base,
      minimumOrderQuantity: variant.minimumOrderQuantity || 1
    };
  }
  return {
    base: variant.price.base,
    sale: variant.price.sale || variant.price.base,
    minimumOrderQuantity: 1
  };
};

// =============================================
// GET /products/all - WITH CACHE
// =============================================
const getProducts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    const filters = { status: 'active' };

    if (req.query.category) {
      const cat = await Category.findOne({ 
        slug: String(req.query.category).toLowerCase() 
      }).select('_id');
      if (cat) filters.category = cat._id;
    }

    if (req.query.featured === 'true') filters.isFeatured = true;

    let sortOption = { createdAt: -1 };
    if (req.query.q) {
      filters.$text = { $search: String(req.query.q) };
      sortOption = { score: { $meta: 'textScore' } };
    }

    const userType = req.userType || 'user';

    // ✅ GENERATE CACHE KEY
    const cacheKey = cacheConfig.generateKey('PRODUCT', {
      page, limit,
      category: req.query.category,
      featured: req.query.featured,
      q: req.query.q,
      userType
    });

    // ✅ CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.json(cachedData);
    }

    const [total, products] = await Promise.all([
      Product.countDocuments(filters),
      Product.find(filters)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .populate('category')
        .lean()
    ]);

    const productsWithData = products.map(product => ({
      ...product,
      variants: product.variants.map(variant => ({
        ...variant,
        price: getVariantPrice(variant, userType)
      }))
    }));

    const responseData = {
      success: true,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1
      },
      products: productsWithData,
      userType: userType
    };

    // ✅ STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_LIST);

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=600');

    return res.json(responseData);

  } catch (err) {
    console.error('getProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/:slug - WITH CACHE
// =============================================
const getProductBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const userType = req.userType || 'user';

    // ✅ GENERATE CACHE KEY
    const cacheKey = cacheConfig.generateKey('PRODUCT', { slug, userType });

    // ✅ CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=900');
      return res.json(cachedData);
    }
    
    const product = await Product.findOne({ 
      slug: String(slug).toLowerCase(), 
      status: 'active' 
    }).populate('category');

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }
    
    const productResponse = {
      ...product.toObject(),
      variants: product.variants.map(variant => ({
        ...variant.toObject(),
        price: getVariantPrice(variant, userType)
      }))
    };

    const responseData = { 
      success: true, 
      product: productResponse,
      userType: userType
    };

    // ✅ STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_DETAIL);

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=900');
    return res.json(responseData);

  } catch (err) {
    console.error('getProductBySlug:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/search - WITH CACHE
// =============================================
const searchProducts = async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) {
      return res.status(400).json({ 
        success: false, 
        message: 'Query required' 
      });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;
    const userType = req.userType || 'user';

    // ✅ GENERATE CACHE KEY
    const cacheKey = cacheConfig.generateKey('SEARCH', { q, page, limit, userType });

    // ✅ CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(cachedData);
    }

    const filters = { 
      status: 'active', 
      $text: { $search: q } 
    };

    const total = await Product.countDocuments(filters);
    const products = await Product.find(filters, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .skip(skip)
      .limit(limit)
      .populate('category')
      .lean();

    const productsWithData = products.map(product => ({
      ...product,
      variants: product.variants.map(variant => ({
        ...variant,
        price: getVariantPrice(variant, userType)
      }))
    }));

    const responseData = { 
      success: true, 
      total, 
      page, 
      limit, 
      products: productsWithData,
      userType: userType
    };

    // ✅ STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_SEARCH);

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(responseData);

  } catch (err) {
    console.error('searchProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/category/:slug - WITH CACHE
// =============================================
const getProductsByCategory = async (req, res) => {
  try {
    const { slug } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;
    const userType = req.userType || 'user';

    // ✅ GENERATE CACHE KEY
    const cacheKey = cacheConfig.generateKey('PRODUCT', { categorySlug: slug, page, limit, userType });

    // ✅ CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.json(cachedData);
    }

    const category = await Category.findOne({ 
      slug: String(slug).toLowerCase() 
    });
    
    if (!category) {
      return res.status(404).json({ 
        success: false, 
        message: 'Category not found' 
      });
    }

    const filters = { 
      status: 'active', 
      category: category._id 
    };

    const total = await Product.countDocuments(filters);
    const products = await Product.find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('category')
      .lean();

    const productsWithData = products.map(product => ({
      ...product,
      variants: product.variants.map(variant => ({
        ...variant,
        price: getVariantPrice(variant, userType)
      }))
    }));

    const responseData = { 
      success: true, 
      total, 
      page, 
      limit, 
      products: productsWithData, 
      category,
      userType: userType
    };

    // ✅ STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_CATEGORY);

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.json(responseData);

  } catch (err) {
    console.error('getProductsByCategory:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/featured - WITH CACHE
// =============================================
// =============================================
// GET /products/featured - WITH PAGINATION & CACHE
// =============================================
const getFeaturedProducts = async (req, res) => {
  try {
    // ✅ ADD PAGINATION SUPPORT
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;
    
    const userType = req.userType || 'user';

    // ✅ GENERATE CACHE KEY (include page now)
    const cacheKey = cacheConfig.generateKey('PRODUCT', { 
      featured: true, 
      page, 
      limit, 
      userType 
    });

    // ✅ CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=900');
      return res.json(cachedData);
    }

    const filters = { 
      status: 'active', 
      isFeatured: true 
    };

    // ✅ GET TOTAL COUNT FOR PAGINATION
    const total = await Product.countDocuments(filters);

    const products = await Product.find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('category')
      .lean();

    const productsWithData = products.map(product => ({
      ...product,
      variants: product.variants.map(variant => ({
        ...variant,
        price: getVariantPrice(variant, userType)
      }))
    }));

    const responseData = { 
      success: true, 
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1
      },
      products: productsWithData,
      userType: userType
    };

    // ✅ STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_FEATURED);

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=900');
    return res.json(responseData);

  } catch (err) {
    console.error('getFeaturedProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/:slug/related - WITH CACHE
// =============================================
const getRelatedProducts = async (req, res) => {
  try {
    const { slug } = req.params;
    const limit = Math.max(1, parseInt(req.query.limit) || 8);
    const userType = req.userType || 'user';

    // ✅ GENERATE CACHE KEY
    const cacheKey = cacheConfig.generateKey('PRODUCT', { related: slug, limit, userType });

    // ✅ CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    const product = await Product.findOne({ 
      slug: String(slug).toLowerCase(), 
      status: 'active' 
    });
    
    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    const related = await Product.find({
      _id: { $ne: product._id },
      category: product.category,
      status: 'active'
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('category')
      .lean();

    const relatedWithData = related.map(rel => ({
      ...rel,
      variants: rel.variants.map(variant => ({
        ...variant,
        price: getVariantPrice(variant, userType)
      }))
    }));

    const responseData = { 
      success: true, 
      related: relatedWithData,
      userType: userType
    };

    // ✅ STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_RELATED);

    res.setHeader('X-Cache', 'MISS');
    return res.json(responseData);

  } catch (err) {
    console.error('getRelatedProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/detailed/:id - NO CACHE (admin/debug use)
// =============================================
const getProductDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id).populate('category');

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const userType = req.userType || 'user';

    const productResponse = {
      ...product.toObject(),
      variants: product.variants.map(variant => ({
        ...variant.toObject(),
        price: getVariantPrice(variant, userType)
      }))
    };

    res.status(200).json({
      success: true,
      product: productResponse,
      userType: userType
    });

  } catch (error) {
    console.log(error.message);
    res.status(500).json({ message: 'Error fetching product details', error });
  }
};

module.exports = {
  getProducts,
  getProductBySlug,
  searchProducts,
  getProductsByCategory,
  getFeaturedProducts,
  getRelatedProducts,
  getProductDetails
};