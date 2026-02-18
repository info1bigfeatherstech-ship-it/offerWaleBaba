const User = require('../models/User');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { validationResult } = require('express-validator');
const { redisClient } = require('../config/redis.config');
const tokenStore = require('../config/tokenBlacklist');
const { token } = require('morgan');

// Helper to extract token from Authorization header
const getTokenFromHeader = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
};

// Configure nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASSWORD || 'your-app-password'
  }
});

// Generate Access and Refresh Tokens
const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';

const generateAccessToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: ACCESS_EXPIRES
  });
};

const generateRefreshToken = (id) => {
  return jwt.sign({ id }, process.env.REFRESH_TOKEN_SECRET || 'your-secret-keyy', {
    expiresIn: REFRESH_EXPIRES
  });
};

const getRefreshCookieOptions = () => {
  const secure = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  };
};

// Register Controller
const register = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password, firstname, lastname, phone } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email }).select('+emailVerificationOTP +emailVerificationOTPExpires +isVerified');
    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(409).json({ success: false, message: 'User with this email already exists. Please login.' });
      }

      // If user exists but not verified, regenerate OTP and resend
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 15 * 60 * 1000);
      existingUser.emailVerificationOTP = otp;
      existingUser.emailVerificationOTPExpires = expires;
      existingUser.profile.firstname = firstname || existingUser.profile.firstname;
      if (lastname) existingUser.profile.lastname = lastname;
      if (phone) existingUser.profile.phone = phone;
      if (password) existingUser.password = password;
      await existingUser.save();

      const mailOptions = {
        from: process.env.EMAIL_USER || 'info1.bigfeatherstech@gmail.com',
        to: email,
        subject: 'Verify your email',
        html: `<p>Your verification OTP is <strong>${otp}</strong>. It expires in 15 minutes.</p>`
      };
      transporter.sendMail(mailOptions, (error) => { if (error) console.error('Verification email error:', error); });

      return res.status(200).json({ success: true, message: 'Verification OTP resent to email' });
    }

    // Create new user (unverified)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    const user = new User({
      email,
      password,
      profile: { firstname, lastname, phone },
      role: 'user',
      status: 'inactive',
      isVerified: false,
      emailVerificationOTP: otp,
      emailVerificationOTPExpires: expires
    });

    await user.save();

    const mailOptions = {
      from: process.env.EMAIL_USER || 'info1.bigfeatherstech@gmail.com',
      to: email,
      subject: 'Verify your email',
      html: `<p>Your verification OTP is <strong>${otp}</strong>. It expires in 15 minutes.</p>`
    };
    transporter.sendMail(mailOptions, (error) => { if (error) console.error('Verification email error:', error); });

    return res.status(200).json({ success: true, message: 'Verification OTP sent to email' });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error during registration',
      error: error.message
    });
  }
};

// Verify OTP after registration and log in
const verifyRegistrationOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP are required' });

    const user = await User.findOne({ email }).select('+password +emailVerificationOTP +emailVerificationOTPExpires +isVerified');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.isVerified) return res.status(400).json({ success: false, message: 'User already verified. Please login.' });

    if (!user.emailVerificationOTP || !user.emailVerificationOTPExpires) {
      return res.status(400).json({ success: false, message: 'No verification request found' });
    }

    if (user.emailVerificationOTP !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    if (new Date() > user.emailVerificationOTPExpires) return res.status(400).json({ success: false, message: 'OTP has expired' });

    user.isVerified = true;
    user.status = 'active';
    user.emailVerificationOTP = undefined;
    user.emailVerificationOTPExpires = undefined;
    await user.save();

    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);
    res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());
    return res.status(200).json({ success: true, message: 'Verification successful', accessToken, user: { id: user._id, email: user.email, firstname: user.profile.firstname, lastname: user.profile.lastname } });
  } catch (error) {
    console.error('Verify registration OTP error:', error);
    return res.status(500).json({ success: false, message: 'Error verifying OTP', error: error.message });
  }
};

// Login Controller
const login = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Find user by email and select password field
    const user = await User.findOne({ email }).select('+password');

    // Check if user exists
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if user is verified and active
    if (!user.isVerified) {
      return res.status(403).json({ success: false, message: 'Account not verified. Please verify email.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Your account is not active' });
    }

    // Compare passwords
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Generate token
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);
    // Set refresh token in HttpOnly cookie
    res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());
    // Return success response with access token
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        firstname: user.profile.firstname,
        lastname: user.profile.lastname,
        phone: user.profile.phone,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error during login',
      error: error.message
    });
  }
};

// Logout (blacklist token)
const logout = async (req, res) => {
  try {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token is required' });
    }

  
    // Decode token to get expiry
    const decoded = jwt.decode(token);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = decoded && decoded.exp ? Math.max(0, decoded.exp - nowSeconds) : 0;

    if (redisClient) {
      try {
        await redisClient.set(`bl_${token}`, '1');
        if (ttl > 0) {
          await redisClient.expire(`bl_${token}`, ttl);
        }
      } catch (err) {
        // Fallback to in-memory if Redis write fails
        tokenStore.add(token, ttl);
      }
    } else {
      tokenStore.add(token, ttl);
    }

    // Clear refresh token cookie
    try {
      res.clearCookie('refreshToken', getRefreshCookieOptions());
    } catch (e) {
      // ignore if cookies not present
    }

    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ success: false, message: 'Error during logout', error: error.message });
  }
};

// Refresh access token using refresh token cookie
const refreshAccessToken = async (req, res) => {
  try {
    const refreshToken = req.cookies && req.cookies.refreshToken;
    if (!refreshToken) return res.status(401).json({ success: false, message: 'Refresh token missing' });

    // Verify refresh token
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET || 'your-secret-keyy');
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    const userId = decoded.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const accessToken = generateAccessToken(userId);
    return res.status(200).json({ success: true, accessToken });
  } catch (error) {
    console.error('Refresh token error:', error);
    return res.status(500).json({ success: false, message: 'Could not refresh token', error: error.message });
  }
};

// Get current user profile
const me = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        firstname: user.profile.firstname,
        lastname: user.profile.lastname,
        phone: user.profile.phone,
        role: user.role,
        status: user.status
      } , token: getTokenFromHeader(req)
    });
  } catch (error) {
    console.error('Me error:', error);
    return res.status(500).json({ success: false, message: 'Error fetching profile', error: error.message });
  }
};

// Update user profile (protected)
const updateProfile = async (req, res) => {
  try {
    const allowed = ['firstname', 'lastname', 'phone', 'email'];
    const updates = {};

    if (req.body.email) updates.email = req.body.email;
    if (req.body.firstname) updates['profile.firstname'] = req.body.firstname;
    if (req.body.lastname) updates['profile.lastname'] = req.body.lastname;
    if (req.body.phone) updates['profile.phone'] = req.body.phone;

    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.status(200).json({ success: true, message: 'Profile updated', user });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ success: false, message: 'Error updating profile', error: error.message });
  }
};

// Change password (protected)
const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Old and new passwords are required' });
    }

    const user = await User.findById(req.userId).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isValid = await user.comparePassword(oldPassword);
    if (!isValid) return res.status(401).json({ success: false, message: 'Old password is incorrect' });

    user.password = newPassword;
    await user.save();

    return res.status(200).json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ success: false, message: 'Error changing password', error: error.message });
  }
};

// Forgot password - generate OTP and email
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User with this email not found' });

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    user.passwordResetOTP = otp;
    user.passwordResetOTPExpires = expires;
    await user.save();

    const mailOptions = {
      from: process.env.EMAIL_USER || 'info1.bigfeatherstech@gmail.com',
      to: email,
      subject: 'Password Reset OTP',
      html: `<p>Your password reset OTP is <strong>${otp}</strong>. It expires in 15 minutes.</p>`
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) console.error('Forgot password email error:', error);
    });

    return res.status(200).json({ success: true, message: 'OTP sent to email if account exists' });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ success: false, message: 'Error processing forgot password', error: error.message });
  }
};

// Reset password with OTP (no auth)
const resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ success: false, message: 'Email, OTP and newPassword are required' });

    const user = await User.findOne({ email }).select('+password +passwordResetOTP +passwordResetOTPExpires');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.passwordResetOTP || !user.passwordResetOTPExpires) {
      return res.status(400).json({ success: false, message: 'No reset request found' });
    }

    if (user.passwordResetOTP !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    if (new Date() > user.passwordResetOTPExpires) {
      return res.status(400).json({ success: false, message: 'OTP has expired' });
    }

    user.password = newPassword;
    user.passwordResetOTP = undefined;
    user.passwordResetOTPExpires = undefined;
    await user.save();

    return res.status(200).json({ success: true, message: 'Password has been reset. You can now login with the new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ success: false, message: 'Error resetting password', error: error.message });
  }
};

module.exports = { register, login, logout, me, updateProfile, changePassword, forgotPassword, resetPassword, verifyRegistrationOTP, refreshAccessToken };

