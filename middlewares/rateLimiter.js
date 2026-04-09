const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// Different limits for different endpoints (Industry standard)
const rateLimits = {
  // Public read operations - HIGH limit (products, categories)
  publicRead: {
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: 'Too many requests, please slow down'
  },
  
  // Search operations - MEDIUM limit
  search: {
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Search limit exceeded, please wait'
  },
  
  // Write operations - LOW limit (cart, wishlist, addresses)
  write: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many write operations'
  },
  
  // Sensitive operations - VERY LOW limit (auth, checkout)
  sensitive: {
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many attempts, please try later'
  },
  
  // Admin operations - MEDIUM limit
  admin: {
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'Admin rate limit exceeded'
  }
};

// Factory function to create rate limiters
const createRateLimiter = (type, skipPaths = []) => {
  const config = rateLimits[type];
  if (!config) throw new Error(`Invalid rate limit type: ${type}`);
  
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    skip: (req) => skipPaths.includes(req.path),
    // ✅ REMOVE keyGenerator line - library handles automatically
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const logLevel = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
      logger[logLevel](`Rate limit exceeded (${type}): ${req.ip} - ${req.method} ${req.path}`);
      
      res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: config.message,
        retryAfter: Math.ceil(config.windowMs / 1000),
        timestamp: new Date().toISOString()
      });
    }
  });
};

// Pre-configured limiters
const limiters = {
  products: createRateLimiter('publicRead', ['/health', '/api/health']),
  categories: createRateLimiter('publicRead', ['/health', '/api/health']),
  search: createRateLimiter('search', ['/health', '/api/health']),
  write: createRateLimiter('write', ['/health', '/api/health']),
  sensitive: createRateLimiter('sensitive', ['/health', '/api/health']),
  admin: createRateLimiter('admin', ['/health', '/api/health'])
};

module.exports = { limiters, createRateLimiter };