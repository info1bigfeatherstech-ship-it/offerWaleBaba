const User = require('../models/User');

// Middleware to determine user type and attach it to the request object
const userTypeMiddleware = async (req, res, next) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        req.userType = user.userType; // Attach userType to the request object
        next();
    } catch (error) {
        res.status(500).json({ message: 'Error determining user type', error });
    }
};

module.exports = {userTypeMiddleware};
