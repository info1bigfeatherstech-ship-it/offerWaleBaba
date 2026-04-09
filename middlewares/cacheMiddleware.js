const cacheService = require('../services/cache.service');
const cacheConfig = require('../config/cache.config');
const logger = require('../utils/logger');

/**
 * Generic cache middleware factory
 * @param {string} endpointType - Type of endpoint (PRODUCT_LIST, CATEGORY_LIST, etc.)
 * @param {Function} keyGenerator - Function that generates cache key from req
 */
const cacheMiddleware = (endpointType, keyGenerator) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }
    
    // Skip cache for authenticated user-specific data
    if (req.userId && endpointType === 'USER_SPECIFIC') {
      return next();
    }
    
    const cacheKey = keyGenerator(req);
    const ttl = cacheConfig.getTTL(endpointType);
    
    try {
      const cachedData = await cacheService.get(cacheKey);
      
      if (cachedData) {
        // Set cache headers
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Cache-Control', `public, max-age=${ttl}`);
        return res.json(cachedData);
      }
      
      // Store original json method
      const originalJson = res.json;
      
      // Override json method to cache response
      res.json = function(data) {
        // Restore original method
        res.json = originalJson;
        
        // Only cache successful responses
        if (data && data.success !== false) {
          cacheService.set(cacheKey, data, ttl).catch(err => {
            logger.error(`[Cache] Failed to cache: ${err.message}`);
          });
        }
        
        // Set cache headers
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('Cache-Control', `public, max-age=${ttl}`);
        
        // Send response
        return originalJson.call(this, data);
      };
      
      next();
      
    } catch (error) {
      logger.error(`[Cache] Middleware error: ${error.message}`);
      next();
    }
  };
};

// Pre-defined key generators for different endpoints
const keyGenerators = {
  // Product endpoints
  productList: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      page: req.query.page || 1,
      limit: req.query.limit || 12,
      category: req.query.category,
      featured: req.query.featured,
      q: req.query.q,
      userType: req.userType || 'user'
    });
  },
  
  productDetail: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      slug: req.params.slug,
      userType: req.userType || 'user'
    });
  },
  
  productSearch: (req) => {
    return cacheConfig.generateKey('SEARCH', {
      q: req.query.q,
      page: req.query.page || 1,
      limit: req.query.limit || 12,
      userType: req.userType || 'user'
    });
  },
  
  productCategory: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      slug: req.params.slug,
      page: req.query.page || 1,
      limit: req.query.limit || 12,
      userType: req.userType || 'user'
    });
  },
  
  productFeatured: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      featured: true,
      limit: req.query.limit || 12,
      userType: req.userType || 'user'
    });
  },
  
  productRelated: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      related: req.params.slug,
      limit: req.query.limit || 8,
      userType: req.userType || 'user'
    });
  },
  
  // Category endpoints
  categoryList: (req) => {
    return cacheConfig.generateKey('CATEGORY', {
      all: true
    });
  },
  
  categoryDetail: (req) => {
    return cacheConfig.generateKey('CATEGORY', {
      id: req.params.id
    });
  },
  
  // Analytics endpoints
  analyticsDashboard: (req) => {
    return cacheConfig.generateKey('ANALYTICS', {
      dashboard: true
    });
  },
  
  analyticsUsers: (req) => {
    return cacheConfig.generateKey('ANALYTICS', {
      users: true,
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      search: req.query.search,
      role: req.query.role
    });
  },
  
  analyticsCarts: (req) => {
    return cacheConfig.generateKey('ANALYTICS', {
      carts: true,
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      sortBy: req.query.sortBy,
      order: req.query.order
    });
  }
};

module.exports = { cacheMiddleware, keyGenerators };