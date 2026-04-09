// Industry-standard cache configuration
const logger = require('../utils/logger');

class CacheConfig {
  constructor() {
    // TTL in seconds for different endpoints
    this.ttl = {
      // Product endpoints
      PRODUCT_LIST: 600,        // 10 minutes
      PRODUCT_DETAIL: 900,      // 15 minutes
      PRODUCT_SEARCH: 300,      // 5 minutes
      PRODUCT_CATEGORY: 600,    // 10 minutes
      PRODUCT_FEATURED: 900,    // 15 minutes
      PRODUCT_RELATED: 600,     // 10 minutes
      
      // Category endpoints
      CATEGORY_LIST: 1800,      // 30 minutes
      CATEGORY_DETAIL: 1800,    // 30 minutes
      
      // Analytics endpoints (admin only)
      ANALYTICS_DASHBOARD: 300, // 5 minutes
      ANALYTICS_USERS: 120,     // 2 minutes
      ANALYTICS_CARTS: 120,     // 2 minutes
      
      // Default
      DEFAULT: 300              // 5 minutes
    };
    
    // Cache key prefixes
    this.prefixes = {
      PRODUCT: 'p',
      CATEGORY: 'c',
      SEARCH: 's',
      ANALYTICS: 'a',
      USER: 'u'
    };
  }
  
  generateKey(prefix, params) {
    // Sort params for consistent keys
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((acc, key) => {
        if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
          acc[key] = params[key];
        }
        return acc;
      }, {});
    
    // Create short hash for query params
    const hash = Buffer.from(JSON.stringify(sortedParams))
      .toString('base64')
      .substring(0, 32)
      .replace(/[/+=]/g, '_');
    
    return `${this.prefixes[prefix] || 'x'}:${hash}`;
  }
  
  getTTL(endpointType) {
    return this.ttl[endpointType] || this.ttl.DEFAULT;
  }
  
  // Invalidation patterns
  getInvalidationPatterns(productId, categoryId) {
    const patterns = [];
    
    if (productId) {
      patterns.push(`${this.prefixes.PRODUCT}:*`);
      patterns.push(`${this.prefixes.SEARCH}:*`);
    }
    
    if (categoryId) {
      patterns.push(`${this.prefixes.CATEGORY}:*`);
      patterns.push(`${this.prefixes.PRODUCT}:*`);
    }
    
    // Always invalidate lists
    patterns.push(`${this.prefixes.PRODUCT}:*`);
    patterns.push(`${this.prefixes.SEARCH}:*`);
    
    return patterns;
  }
}

module.exports = new CacheConfig();