const jwt = require('jsonwebtoken');
const { redisClient } = require('../config/redis.config');
const tokenStore = require('../config/tokenBlacklist');

/**
 * Verify JWT Token Middleware
 * Checks for valid JWT token in Authorization header (Bearer token)
 */
const verifyToken = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'User is not logged in',
        code: 'MISSING_AUTH_HEADER'
      });
    }

    // Extract Bearer token
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token is required',
        code: 'MISSING_TOKEN'
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key'
    );

    // Check blacklist (Redis first, then in-memory fallback)
    try {
      if (redisClient) {
        const isBlacklisted = await redisClient.get(`bl_${token}`);
        if (isBlacklisted) {
          return res.status(401).json({ success: false, message: 'Token is blacklisted', code: 'TOKEN_BLACKLISTED' });
        }
      } else if (tokenStore.has(token)) {
        return res.status(401).json({ success: false, message: 'Token is blacklisted', code: 'TOKEN_BLACKLISTED' });
      }
    } catch (err) {
      // If Redis errors, fall back to in-memory check only
      if (tokenStore.has(token)) {
        return res.status(401).json({ success: false, message: 'Token is blacklisted', code: 'TOKEN_BLACKLISTED' });
      }
    }

    // Attach user id to request object
    req.userId = decoded.id;
    next();
  } catch (error) {
    // Handle specific JWT errors
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired',
        code: 'TOKEN_EXPIRED'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Error verifying token',
      error: error.message
    });
  }
};

module.exports = { verifyToken };


