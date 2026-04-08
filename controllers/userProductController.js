// controllers/userProductController.js
const Product = require('../models/Product');
const Category = require('../models/Category');

// ✅ ONLY PRICE LOGIC - Baaki sab same
const getVariantPrice = (variant, userType) => {
  if (userType === 'wholesaler') {
    // Wholesaler ko wholesale price
    return {
      base: variant.price.wholesaleBase || variant.price.base,
      sale: variant.price.wholesaleSale || variant.price.wholesaleBase || variant.price.base,
      minimumOrderQuantity: variant.minimumOrderQuantity || 1
    };
  }
  // Normal user ya guest ko normal price
  return {
    base: variant.price.base,
    sale: variant.price.sale || variant.price.base,
    minimumOrderQuantity: 1
  };
};

// =============================================
// GET /products/all
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

    const [total, products] = await Promise.all([
      Product.countDocuments(filters),
      Product.find(filters)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .populate('category')
        .lean()
    ]);

    // ✅ SAB KUCH RETURN KARO - VARIANTS KE SAATH
    const productsWithData = products.map(product => ({
      ...product,
      variants: product.variants.map(variant => ({
        ...variant,
        price: getVariantPrice(variant, userType)
      }))
    }));

    res.set('Cache-Control', 'public, max-age=600');

    return res.json({
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
    });

  } catch (err) {
    console.error('getProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/:slug
// =============================================
const getProductBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    
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

    const userType = req.userType || 'user';
    
    const productResponse = {
      ...product.toObject(),
      variants: product.variants.map(variant => ({
        ...variant.toObject(),
        price: getVariantPrice(variant, userType)
      }))
    };

    res.set('Cache-Control', 'public, max-age=900');
    return res.json({ 
      success: true, 
      product: productResponse,
      userType: userType
    });

  } catch (err) {
    console.error('getProductBySlug:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/search
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

    const filters = { 
      status: 'active', 
      $text: { $search: q } 
    };

    const userType = req.userType || 'user';

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

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ 
      success: true, 
      total, 
      page, 
      limit, 
      products: productsWithData,
      userType: userType
    });

  } catch (err) {
    console.error('searchProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/category/:slug
// =============================================
const getProductsByCategory = async (req, res) => {
  try {
    const { slug } = req.params;
    const category = await Category.findOne({ 
      slug: String(slug).toLowerCase() 
    });
    
    if (!category) {
      return res.status(404).json({ 
        success: false, 
        message: 'Category not found' 
      });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    const filters = { 
      status: 'active', 
      category: category._id 
    };

    const userType = req.userType || 'user';

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

    res.set('Cache-Control', 'public, max-age=600');
    return res.json({ 
      success: true, 
      total, 
      page, 
      limit, 
      products: productsWithData, 
      category,
      userType: userType
    });

  } catch (err) {
    console.error('getProductsByCategory:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/featured
// =============================================
const getFeaturedProducts = async (req, res) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const userType = req.userType || 'user';

    const products = await Product.find({ 
      status: 'active', 
      isFeatured: true 
    })
      .sort({ createdAt: -1 })
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

    res.set('Cache-Control', 'public, max-age=900');
    return res.json({ 
      success: true, 
      products: productsWithData,
      userType: userType
    });

  } catch (err) {
    console.error('getFeaturedProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/:slug/related
// =============================================
const getRelatedProducts = async (req, res) => {
  try {
    const { slug } = req.params;
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

    const limit = Math.max(1, parseInt(req.query.limit) || 8);
    const userType = req.userType || 'user';

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

    return res.json({ 
      success: true, 
      related: relatedWithData,
      userType: userType
    });

  } catch (err) {
    console.error('getRelatedProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/detailed/:id
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