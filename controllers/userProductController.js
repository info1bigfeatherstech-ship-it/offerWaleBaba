const Product = require('../models/Product');
const Category = require('../models/Category');

// GET /products
const getProducts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    const filters = { status: 'active' };

    // Category
    if (req.query.category) {
      const cat = await Category.findOne({ 
        slug: String(req.query.category).toLowerCase() 
      }).select('_id');
      if (cat) filters.category = cat._id;
    }

    // Price filter
    const minPrice = Number(req.query.minPrice);
    const maxPrice = Number(req.query.maxPrice);

    if (!isNaN(minPrice) || !isNaN(maxPrice)) {
      filters['price.base'] = {};
      if (!isNaN(minPrice)) filters['price.base'].$gte = minPrice;
      if (!isNaN(maxPrice)) filters['price.base'].$lte = maxPrice;
    }

    // Featured
    if (req.query.featured === 'true') filters.isFeatured = true;

    // Search
    let sortOption = { createdAt: -1 };

    if (req.query.q) {
      filters.$text = { $search: String(req.query.q) };
      sortOption = { score: { $meta: 'textScore' } };
    }

    const [total, products] = await Promise.all([
  Product.countDocuments(filters),
  (async () => {
    const query = Product.find(filters);

    if (req.query.q) {
      query
        .select({ score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } });
    } else {
      query.sort(sortOption);
    }

    return query
      .skip(skip)
      .limit(limit)
      .populate('category')
  })()
]);

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
      products
    });

  } catch (err) {
    console.error('getProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
// try { 
//     const products = await Product.find({ status: 'active' }).populate('category', 'name').sort({ createdAt: -1 });
//     return res.status(200).json({ success: true, count: products.length, products });
//   } catch (error) {
//     console.error('Get all products error:', error);
//     return res.status(500).json({ success: false, message: 'Error fetching products', error: error.message });
//   } 
};

// GET /products/:slug
const getProductBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const product = await Product.findOne({ slug: String(slug).toLowerCase(), status: 'active' }).populate('category');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    res.set('Cache-Control', 'public, max-age=900'); // 15 minutes
    return res.json({ success: true, product });
  } catch (err) {
    console.error('getProductBySlug:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /products/search?q=query
const searchProducts = async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.status(400).json({ success: false, message: 'Query required' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    const filters = { status: 'active', $text: { $search: q } };

    const total = await Product.countDocuments(filters);
    const products = await Product.find(filters, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .skip(skip)
      .limit(limit)
      .populate('category');

    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    return res.json({ success: true, total, page, limit, products });
  } catch (err) {
    console.error('searchProducts:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /products/category/:slug
const getProductsByCategory = async (req, res) => {
  try {
    const { slug } = req.params;
    const category = await Category.findOne({ slug: String(slug).toLowerCase() });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    const filters = { status: 'active', category: category._id };

    const total = await Product.countDocuments(filters);
    const products = await Product.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('category');

    res.set('Cache-Control', 'public, max-age=600'); // 10 minutes
    return res.json({ success: true, total, page, limit, products, category });
  } catch (err) {
    console.error('getProductsByCategory:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /products/featured
const getFeaturedProducts = async (req, res) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const products = await Product.find({ status: 'active', isFeatured: true }).sort({ createdAt: -1 }).limit(limit).populate('category');
    res.set('Cache-Control', 'public, max-age=900'); // 15 minutes
    return res.json({ success: true, products });
  } catch (err) {
    console.error('getFeaturedProducts:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /products/:slug/related
const getRelatedProducts = async (req, res) => {
  try {
    const { slug } = req.params;
    const product = await Product.findOne({ slug: String(slug).toLowerCase(), status: 'active' });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const limit = Math.max(1, parseInt(req.query.limit) || 8);
    const related = await Product.find({
      _id: { $ne: product._id },
      category: product.category,
      status: 'active'
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('category');

    return res.json({ success: true, related });
  } catch (err) {
    console.error('getRelatedProducts:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  getProducts,
  getProductBySlug,
  searchProducts,
  getProductsByCategory,
  getFeaturedProducts,
  getRelatedProducts
};
