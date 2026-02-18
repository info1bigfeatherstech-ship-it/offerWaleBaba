const { verifyToken } = require('./auth');
const User = require('../models/User');

// Middleware that ensures user is authenticated and has admin role
const requireAdmin = async (req, res, next) => {
  try {
    // First verify token
    await verifyToken(req, res, async () => {
      // verifyToken sets req.userId
      const user = await User.findById(req.userId);
      if (!user) return res.status(403).json({ success: false, message: 'User not found' });
      if (user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin access required' });
      req.user = user;
      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error authorizing user', error: error.message });
  }
};


module.exports = { requireAdmin };
