const { verifyToken } = require('./auth.middleware');
const User = require('../models/User');

// Middleware that ensures user is authenticated and has admin role
const requireAdmin = async (req, res, next) => {
  try {
    await verifyToken(req, res, async () => {
      const user = req.user || await User.findById(req.userId).select('userType role');

      if (!user) {
        return res.status(403).json({ success: false, message: 'User not found' });
      }

      const role = String(user.role || user.userType || 'user').toLowerCase();

      if (role !== 'admin' && role !== 'superadmin' && user.userType !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      req.user = {
        id: user._id.toString(),
        role
      };
      req.userId = user._id.toString();
      req.userType = user.userType || 'user';

      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error authorizing user', error: error.message });
  }
};

module.exports = { requireAdmin };

