

// // controllers/userProductController.js
// const Product = require('../models/Product');
// const Category = require('../models/Category');

// // Helper function to get user-specific variant pricing
// const getVariantPrice = (variant, userType) => {
//   if (userType === 'wholesaler') {
//     return {
//       base: variant.price.wholesaleBase || variant.price.base,
//       sale: variant.price.wholesaleSale || variant.price.wholesaleBase || variant.price.base,
//       minimumOrderQuantity: variant.minimumOrderQuantity || 1
//     };
//   }
//   return {
//     base: variant.price.base,
//     sale: variant.price.sale || variant.price.base,
//     minimumOrderQuantity: 1
//   };
// };

// // Helper function to calculate min/max price for a product
// const getProductPriceRange = (product, userType) => {
//   let minPrice = Infinity;
//   let maxPrice = -Infinity;
  
//   for (const variant of product.variants) {
//     const price = getVariantPrice(variant, userType);
//     const finalPrice = price.sale || price.base;
    
//     if (finalPrice < minPrice) minPrice = finalPrice;
//     if (finalPrice > maxPrice) maxPrice = finalPrice;
//   }
  
//   return {
//     min: minPrice !== Infinity ? minPrice : 0,
//     max: maxPrice !== -Infinity ? maxPrice : minPrice
//   };
// };

// // GET /products/all
// const getProducts = async (req, res) => {
//   try {
//     const page = Math.max(1, parseInt(req.query.page) || 1);
//     const limit = Math.max(1, parseInt(req.query.limit) || 12);
//     const skip = (page - 1) * limit;

//     const filters = { status: 'active' };

//     if (req.query.category) {
//       const cat = await Category.findOne({ 
//         slug: String(req.query.category).toLowerCase() 
//       }).select('_id');
//       if (cat) filters.category = cat._id;
//     }

//     const minPrice = Number(req.query.minPrice);
//     const maxPrice = Number(req.query.maxPrice);
//     // Note: Price filtering is complex with variants, might need aggregation
//     // For simplicity, we'll filter after fetching or use aggregation

//     if (req.query.featured === 'true') filters.isFeatured = true;

//     let sortOption = { createdAt: -1 };
//     if (req.query.q) {
//       filters.$text = { $search: String(req.query.q) };
//       sortOption = { score: { $meta: 'textScore' } };
//     }

//     const userType = req.userType || 'user';

//     const [total, products] = await Promise.all([
//       Product.countDocuments(filters),
//       Product.find(filters)
//         .sort(sortOption)
//         .skip(skip)
//         .limit(limit)
//         .populate('category', 'name')
//         .lean()
//     ]);

//     const productsWithPricing = products.map(product => {
//       const priceRange = getProductPriceRange(product, userType);
      
//       return {
//         ...product,
//         variants: undefined, // Remove variants from list view
//         userPrice: {
//           min: priceRange.min,
//           max: priceRange.max,
//           isSinglePrice: priceRange.min === priceRange.max,
//           currency: 'INR'
//         },
//         userType: userType
//       };
//     });

//     res.set('Cache-Control', 'public, max-age=600');

//     return res.json({
//       success: true,
//       pagination: {
//         total,
//         page,
//         limit,
//         totalPages: Math.ceil(total / limit),
//         hasNextPage: page * limit < total,
//         hasPrevPage: page > 1
//       },
//       products: productsWithPricing,
//       userType: userType
//     });

//   } catch (err) {
//     console.error('getProducts:', err);
//     return res.status(500).json({ 
//       success: false, 
//       message: 'Server error' 
//     });
//   }
// };

// // GET /products/:slug
// const getProductBySlug = async (req, res) => {
//   try {
//     const { slug } = req.params;
    
//     const product = await Product.findOne({ 
//       slug: String(slug).toLowerCase(), 
//       status: 'active' 
//     }).populate('category');

//     if (!product) {
//       return res.status(404).json({ 
//         success: false, 
//         message: 'Product not found' 
//       });
//     }

//     const userType = req.userType || 'user';
    
//     const variantsWithPricing = product.variants.map((variant) => {
//       const price = getVariantPrice(variant, userType);
      
//       return {
//         _id: variant._id,
//         sku: variant.sku,
//         barcode: variant.barcode,
//         attributes: variant.attributes,
//         price: price,
//         inventory: variant.inventory,
//         images: variant.images,
//         isActive: variant.isActive,
//         wholesale: variant.wholesale
//       };
//     });

//     const productWithPricing = {
//       ...product.toObject(),
//       variants: variantsWithPricing,
//       userPricing: {
//         userType: userType,
//         isWholesaler: userType === 'wholesaler'
//       }
//     };

//     res.set('Cache-Control', 'public, max-age=900');
//     return res.json({ 
//       success: true, 
//       product: productWithPricing 
//     });

//   } catch (err) {
//     console.error('getProductBySlug:', err);
//     return res.status(500).json({ 
//       success: false, 
//       message: 'Server error' 
//     });
//   }
// };

// // GET /products/search
// const searchProducts = async (req, res) => {
//   try {
//     const q = req.query.q || '';
//     if (!q) {
//       return res.status(400).json({ 
//         success: false, 
//         message: 'Query required' 
//       });
//     }

//     const page = Math.max(1, parseInt(req.query.page) || 1);
//     const limit = Math.max(1, parseInt(req.query.limit) || 12);
//     const skip = (page - 1) * limit;

//     const filters = { 
//       status: 'active', 
//       $text: { $search: q } 
//     };

//     const userType = req.userType || 'user';

//     const total = await Product.countDocuments(filters);
//     const products = await Product.find(filters, { score: { $meta: 'textScore' } })
//       .sort({ score: { $meta: 'textScore' } })
//       .skip(skip)
//       .limit(limit)
//       .populate('category')
//       .lean();

//     const productsWithPricing = products.map(product => {
//       const priceRange = getProductPriceRange(product, userType);
      
//       return {
//         ...product,
//         variants: undefined,
//         userPrice: {
//           min: priceRange.min,
//           max: priceRange.max,
//           isSinglePrice: priceRange.min === priceRange.max
//         }
//       };
//     });

//     res.set('Cache-Control', 'public, max-age=300');
//     return res.json({ 
//       success: true, 
//       total, 
//       page, 
//       limit, 
//       products: productsWithPricing,
//       userType: userType
//     });

//   } catch (err) {
//     console.error('searchProducts:', err);
//     return res.status(500).json({ 
//       success: false, 
//       message: 'Server error' 
//     });
//   }
// };

// // GET /products/category/:slug
// const getProductsByCategory = async (req, res) => {
//   try {
//     const { slug } = req.params;
//     const category = await Category.findOne({ 
//       slug: String(slug).toLowerCase() 
//     });
    
//     if (!category) {
//       return res.status(404).json({ 
//         success: false, 
//         message: 'Category not found' 
//       });
//     }

//     const page = Math.max(1, parseInt(req.query.page) || 1);
//     const limit = Math.max(1, parseInt(req.query.limit) || 12);
//     const skip = (page - 1) * limit;

//     const filters = { 
//       status: 'active', 
//       category: category._id 
//     };

//     const userType = req.userType || 'user';

//     const total = await Product.countDocuments(filters);
//     const products = await Product.find(filters)
//       .sort({ createdAt: -1 })
//       .skip(skip)
//       .limit(limit)
//       .populate('category')
//       .lean();

//     const productsWithPricing = products.map(product => {
//       const priceRange = getProductPriceRange(product, userType);
      
//       return {
//         ...product,
//         variants: undefined,
//         userPrice: {
//           min: priceRange.min,
//           max: priceRange.max,
//           isSinglePrice: priceRange.min === priceRange.max
//         }
//       };
//     });

//     res.set('Cache-Control', 'public, max-age=600');
//     return res.json({ 
//       success: true, 
//       total, 
//       page, 
//       limit, 
//       products: productsWithPricing, 
//       category,
//       userType: userType
//     });

//   } catch (err) {
//     console.error('getProductsByCategory:', err);
//     return res.status(500).json({ 
//       success: false, 
//       message: 'Server error' 
//     });
//   }
// };

// // GET /products/featured
// const getFeaturedProducts = async (req, res) => {
//   try {
//     const limit = Math.max(1, parseInt(req.query.limit) || 12);
//     const userType = req.userType || 'user';

//     const products = await Product.find({ 
//       status: 'active', 
//       isFeatured: true 
//     })
//       .sort({ createdAt: -1 })
//       .limit(limit)
//       .populate('category')
//       .lean();

//     const productsWithPricing = products.map(product => {
//       const priceRange = getProductPriceRange(product, userType);
      
//       return {
//         ...product,
//         variants: undefined,
//         userPrice: {
//           min: priceRange.min,
//           max: priceRange.max,
//           isSinglePrice: priceRange.min === priceRange.max
//         }
//       };
//     });

//     res.set('Cache-Control', 'public, max-age=900');
//     return res.json({ 
//       success: true, 
//       products: productsWithPricing,
//       userType: userType
//     });

//   } catch (err) {
//     console.error('getFeaturedProducts:', err);
//     return res.status(500).json({ 
//       success: false, 
//       message: 'Server error' 
//     });
//   }
// };

// // GET /products/:slug/related
// const getRelatedProducts = async (req, res) => {
//   try {
//     const { slug } = req.params;
//     const product = await Product.findOne({ 
//       slug: String(slug).toLowerCase(), 
//       status: 'active' 
//     });
    
//     if (!product) {
//       return res.status(404).json({ 
//         success: false, 
//         message: 'Product not found' 
//       });
//     }

//     const limit = Math.max(1, parseInt(req.query.limit) || 8);
//     const userType = req.userType || 'user';

//     const related = await Product.find({
//       _id: { $ne: product._id },
//       category: product.category,
//       status: 'active'
//     })
//       .sort({ createdAt: -1 })
//       .limit(limit)
//       .populate('category')
//       .lean();

//     const relatedWithPricing = related.map(rel => {
//       const priceRange = getProductPriceRange(rel, userType);
      
//       return {
//         ...rel,
//         variants: undefined,
//         userPrice: {
//           min: priceRange.min,
//           max: priceRange.max,
//           isSinglePrice: priceRange.min === priceRange.max
//         }
//       };
//     });

//     return res.json({ 
//       success: true, 
//       related: relatedWithPricing,
//       userType: userType
//     });

//   } catch (err) {
//     console.error('getRelatedProducts:', err);
//     return res.status(500).json({ 
//       success: false, 
//       message: 'Server error' 
//     });
//   }
// };

// // GET /products/detailed/:id
// const getProductDetails = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const product = await Product.findById(id).populate('category');

//     if (!product) {
//       return res.status(404).json({ message: 'Product not found' });
//     }

//     const userType = req.userType || 'user';

//     const variantsWithPrice = product.variants.map((variant) => {
//       const price = getVariantPrice(variant, userType);
      
//       return {
//         ...variant.toObject(),
//         computedPrice: price
//       };
//     });

//     res.status(200).json({
//       product: {
//         ...product.toObject(),
//         variants: variantsWithPrice,
//         userType: userType
//       }
//     });

//   } catch (error) {
//     console.log(error.message);
//     res.status(500).json({ message: 'Error fetching product details', error });
//   }
// };

// module.exports = {
//   getProducts,
//   getProductBySlug,
//   searchProducts,
//   getProductsByCategory,
//   getFeaturedProducts,
//   getRelatedProducts,
//   getProductDetails
// };


// controllers/userProductController.js
const Product = require('../models/Product');
const Category = require('../models/Category');

// Helper function to get variant price based on user type
const getVariantPrice = (variant, userType) => {
  // Only wholesaler gets wholesale pricing
  if (userType === 'wholesaler') {
    return {
      base: variant.price.wholesaleBase || variant.price.base,
      sale: variant.price.wholesaleSale || variant.price.wholesaleBase || variant.price.base,
      wholesaleBase: variant.price.wholesaleBase,
      wholesaleSale: variant.price.wholesaleSale,
      minimumOrderQuantity: variant.minimumOrderQuantity || 1
    };
  }
  
  // Normal user or guest - regular pricing only
  return {
    base: variant.price.base,
    sale: variant.price.sale || variant.price.base,
    minimumOrderQuantity: 1
  };
};

// Helper function to calculate min/max price for product listing
const getProductPriceRange = (product, userType) => {
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  
  for (const variant of product.variants) {
    const price = getVariantPrice(variant, userType);
    const finalPrice = price.sale || price.base;
    
    if (finalPrice < minPrice) minPrice = finalPrice;
    if (finalPrice > maxPrice) maxPrice = finalPrice;
  }
  
  const range = {
    min: minPrice !== Infinity ? minPrice : 0,
    max: maxPrice !== -Infinity ? maxPrice : minPrice,
    isSinglePrice: minPrice === maxPrice
  };
  
  return range;
};

// GET /products/all
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

    // Get user type from optionalAuth middleware
    const userType = req.userType || 'user';

    const [total, products] = await Promise.all([
      Product.countDocuments(filters),
      Product.find(filters)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .populate('category', 'name')
        .lean()
    ]);

    const productsWithPricing = products.map(product => {
      const priceRange = getProductPriceRange(product, userType);
      
      // Return product with price field (backward compatible)
      return {
        _id: product._id,
        name: product.name,
        slug: product.slug,
        title: product.title,
        description: product.description,
        category: product.category,
        brand: product.brand,
        status: product.status,
        isFeatured: product.isFeatured,
        images: product.variants?.[0]?.images || [],
        seo: product.seo,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        // Price field based on user type
        price: userType === 'wholesaler' ? {
          base: priceRange.min,
          sale: priceRange.min,
          wholesaleRange: priceRange,
          currency: 'INR'
        } : {
          base: priceRange.min,
          sale: priceRange.min,
          currency: 'INR'
        }
      };
    });

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
      products: productsWithPricing,
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

// GET /products/:slug
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
    
    const variantsWithPricing = product.variants.map((variant) => {
      const price = getVariantPrice(variant, userType);
      
      // Build variant response based on user type
      const variantResponse = {
        _id: variant._id,
        sku: variant.sku,
        barcode: variant.barcode,
        attributes: variant.attributes,
        inventory: variant.inventory,
        images: variant.images,
        isActive: variant.isActive,
        wholesale: variant.wholesale
      };
      
      // Add price field
      if (userType === 'wholesaler') {
        variantResponse.price = {
          base: price.base,
          sale: price.sale,
          wholesaleBase: price.wholesaleBase,
          wholesaleSale: price.wholesaleSale,
          minimumOrderQuantity: price.minimumOrderQuantity
        };
      } else {
        variantResponse.price = {
          base: price.base,
          sale: price.sale
        };
      }
      
      return variantResponse;
    });

    // Build product response
    const productResponse = {
      ...product.toObject(),
      variants: variantsWithPricing
    };
    
    // Remove variants from root level if needed (for backward compatibility)
    delete productResponse.variants;
    
    // Add variants at root level with pricing
    productResponse.variants = variantsWithPricing;

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

// GET /products/search
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

    const productsWithPricing = products.map(product => {
      const priceRange = getProductPriceRange(product, userType);
      
      return {
        ...product,
        variants: undefined,
        price: userType === 'wholesaler' ? {
          base: priceRange.min,
          sale: priceRange.min,
          wholesaleRange: priceRange,
          currency: 'INR'
        } : {
          base: priceRange.min,
          sale: priceRange.min,
          currency: 'INR'
        }
      };
    });

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ 
      success: true, 
      total, 
      page, 
      limit, 
      products: productsWithPricing,
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

// GET /products/category/:slug
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

    const productsWithPricing = products.map(product => {
      const priceRange = getProductPriceRange(product, userType);
      
      return {
        ...product,
        variants: undefined,
        price: userType === 'wholesaler' ? {
          base: priceRange.min,
          sale: priceRange.min,
          wholesaleRange: priceRange,
          currency: 'INR'
        } : {
          base: priceRange.min,
          sale: priceRange.min,
          currency: 'INR'
        }
      };
    });

    res.set('Cache-Control', 'public, max-age=600');
    return res.json({ 
      success: true, 
      total, 
      page, 
      limit, 
      products: productsWithPricing, 
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

// GET /products/featured
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

    const productsWithPricing = products.map(product => {
      const priceRange = getProductPriceRange(product, userType);
      
      return {
        ...product,
        variants: undefined,
        price: userType === 'wholesaler' ? {
          base: priceRange.min,
          sale: priceRange.min,
          wholesaleRange: priceRange,
          currency: 'INR'
        } : {
          base: priceRange.min,
          sale: priceRange.min,
          currency: 'INR'
        }
      };
    });

    res.set('Cache-Control', 'public, max-age=900');
    return res.json({ 
      success: true, 
      products: productsWithPricing,
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

// GET /products/:slug/related
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

    const relatedWithPricing = related.map(rel => {
      const priceRange = getProductPriceRange(rel, userType);
      
      return {
        ...rel,
        variants: undefined,
        price: userType === 'wholesaler' ? {
          base: priceRange.min,
          sale: priceRange.min,
          wholesaleRange: priceRange,
          currency: 'INR'
        } : {
          base: priceRange.min,
          sale: priceRange.min,
          currency: 'INR'
        }
      };
    });

    return res.json({ 
      success: true, 
      related: relatedWithPricing,
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

// GET /products/detailed/:id
const getProductDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id).populate('category');

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const userType = req.userType || 'user';

    const variantsWithPrice = product.variants.map((variant) => {
      const price = getVariantPrice(variant, userType);
      
      const variantObj = variant.toObject();
      
      if (userType === 'wholesaler') {
        variantObj.price = {
          base: price.base,
          sale: price.sale,
          wholesaleBase: price.wholesaleBase,
          wholesaleSale: price.wholesaleSale,
          minimumOrderQuantity: price.minimumOrderQuantity
        };
      } else {
        variantObj.price = {
          base: price.base,
          sale: price.sale
        };
      }
      
      return variantObj;
    });

    const productResponse = product.toObject();
    productResponse.variants = variantsWithPrice;

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