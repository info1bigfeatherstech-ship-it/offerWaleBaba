const User = require('../models/User');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { validationResult } = require('express-validator');
const { redisClient } = require('../config/redis.config');
const tokenStore = require('../config/tokenBlacklist');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

// ✅ Import from OTP service
const { sendOTP, generateOTP } = require("../services/otp.service");

// ========== HELPERS ==========

// Helper to send OTP via SMS
const sendPhoneOTP = async (phone, otp) => {
  try {
    await sendOTP(phone, otp);
    console.log(`✅ OTP sent to ${phone}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send OTP to ${phone}:`, error.message);
    throw error;
  }
};

// Helper to extract token from Authorization header
const getTokenFromHeader = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
};

// Configure nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// ========== TOKEN GENERATION ==========

if (!process.env.JWT_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
  throw new Error('JWT secrets are not configured');
}

const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';

const generateAccessToken = (userId, userType = 'user', role = 'user') => {
  return jwt.sign(
    { id: userId, type: 'access', userType, role },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
};

const generateRefreshToken = (userId) => {
  return jwt.sign(
    { id: userId, type: 'refresh' },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_EXPIRES }
  );
};

const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const getRefreshCookieOptions = () => {
  const secure = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/api/auth/refresh',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
};

// Google OAuth2 client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID || 'NO_CLIENT_ID_SET'
);

// ========== 1️⃣ REGISTER CONTROLLER ==========

const register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password, name, phone } = req.body;

    // Check if email already exists (verified user)
    const existingEmailUser = await User.findOne({ email, isPhoneVerified: true });
    if (existingEmailUser) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists. Please login.'
      });
    }

    // Check if phone already exists (verified user)
    const existingPhoneUser = await User.findOne({ phone, isPhoneVerified: true });
    if (existingPhoneUser) {
      return res.status(409).json({
        success: false,
        message: 'User with this phone number already exists. Please login.'
      });
    }

    // Check if unverified user exists
    const unverifiedUser = await User.findOne({
      $or: [{ email }, { phone }],
      isPhoneVerified: false
    });

    const otp = generateOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    if (unverifiedUser) {
      // Update existing unverified user
      unverifiedUser.name = name || unverifiedUser.name;
      unverifiedUser.email = email;
      unverifiedUser.phone = phone;
      unverifiedUser.password = password;
      unverifiedUser.phoneVerificationOTP = otp;
      unverifiedUser.phoneVerificationOTPExpires = expires;
      await unverifiedUser.save();
    } else {
      // Create new user
      const user = new User({
        name,
        email,
        phone,
        password,
        userType: 'user',
        status: 'active',
        isEmailVerified: false,
        isPhoneVerified: false,
          isProfileComplete: false,  
        registrationMethod: 'phone',
        phoneVerificationOTP: otp,
        phoneVerificationOTPExpires: expires
      });
      await user.save();
    }

    // Send OTP
    await sendPhoneOTP(phone, otp);

    return res.status(200).json({
      success: true,
      message: 'OTP sent to your phone number',
      phone: phone,
      requiresOTPVerification: true
    });

  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error during registration',
      error: error.message
    });
  }
};





// ========== 2️⃣ VERIFY OTP & LOGIN ==========

// Verify OTP on Phone and Auto-Login
const verifyOTPAndLogin = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone number and OTP are required"
      });
    }

    const user = await User.findOne({ phone })
      .select("+phoneVerificationOTP +phoneVerificationOTPExpires +refreshTokens");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found with this phone number"
      });
    }

    // If already verified, just login
    if (user.isPhoneVerified) {
      const accessToken = generateAccessToken(user._id, user.userType, user.role);
      const refreshToken = generateRefreshToken(user._id);
      const hashedRefreshToken = hashToken(refreshToken);

      user.refreshTokens = user.refreshTokens || [];
      user.refreshTokens = user.refreshTokens.filter(t => t.expiresAt > new Date());
      user.refreshTokens.push({
        token: hashedRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
      await user.save();

      res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

      return res.status(200).json({
        success: true,
        message: "Already verified. Logged in successfully.",
        accessToken,
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          userType: user.userType,
          isPhoneVerified: user.isPhoneVerified,
          isEmailVerified: user.isEmailVerified  // ✅ Keep as is
        }
      });
    }

    // Check OTP expiry
    if (!user.phoneVerificationOTPExpires || new Date() > user.phoneVerificationOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new OTP."
      });
    }

    // Check OTP match
    if (user.phoneVerificationOTP !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP"
      });
    }

    // ✅ FIX: Only verify phone, NOT email
    user.isPhoneVerified = true;
    // user.isEmailVerified = true;  // ❌ REMOVE THIS LINE - Email should be verified separately
    user.status = "active";
    user.isProfileComplete = true;  // ✅ Mark profile as complete
    user.phoneVerificationOTP = undefined;
    user.phoneVerificationOTPExpires = undefined;

    // Generate tokens
    const accessToken = generateAccessToken(user._id, user.userType, user.role);
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefreshToken = hashToken(refreshToken);

    user.refreshTokens = user.refreshTokens || [];
    user.refreshTokens = user.refreshTokens.filter(t => t.expiresAt > new Date());
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: "Phone verified successfully. You are now logged in.",
      accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        role: user.role,
        isPhoneVerified: user.isPhoneVerified,
        isEmailVerified: user.isEmailVerified,  // ✅ Will be false until email verified
        isProfileComplete: user.isProfileComplete  // ✅ Will be true now
      }
    });

  } catch (error) {
    console.error("Verify OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Error verifying OTP",
      error: error.message
    });
  }
};

// ========== 3️⃣ LOGIN CONTROLLER (Email/Phone + Password) ==========

const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array()
      });
    }

    const { identifier, password } = req.body;

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { phone: identifier }
      ]
    }).select("+password +refreshTokens");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    if (!user.isPhoneVerified) {
      return res.status(403).json({
        success: false,
        message: "Phone number not verified. Please complete registration."
      });
    }

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your account is not active"
      });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    const accessToken = generateAccessToken(user._id, user.userType, user.role);
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefreshToken = hashToken(refreshToken);

    user.refreshTokens = user.refreshTokens || [];
    user.refreshTokens = user.refreshTokens.filter(t => t.expiresAt > new Date());
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: "Login successful",
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        userType: user.userType,
        role: user.role,
        status: user.status,
        isPhoneVerified: user.isPhoneVerified
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Error during login",
      error: error.message
    });
  }
};

// ========== 4️⃣ FORGOT PASSWORD - REQUEST OTP ==========

const sendPasswordResetOTP = async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return res.status(400).json({
        success: false,
        message: "Email or phone number is required"
      });
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { phone: identifier }
      ]
    });

    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If account exists, OTP will be sent"
      });
    }

    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    user.passwordResetOTP = otp;
    user.passwordResetOTPExpires = otpExpires;
    await user.save({ validateBeforeSave: false });

    const isEmail = identifier.includes('@');

    if (isEmail) {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: 'Password Reset OTP',
        html: `<p>Your password reset OTP is <strong>${otp}</strong>. It expires in 10 minutes.</p>`
      };
      transporter.sendMail(mailOptions, (error) => {
        if (error) console.error('Email error:', error);
      });
    } else {
      await sendPhoneOTP(user.phone, otp);
    }

    return res.status(200).json({
      success: true,
      message: `OTP sent to your ${isEmail ? 'email' : 'phone'}`,
      identifierType: isEmail ? 'email' : 'phone'
    });

  } catch (error) {
    console.error("Send password reset OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Error sending OTP",
      error: error.message
    });
  }
};

// ========== 5️⃣ VERIFY PASSWORD RESET OTP ==========

const verifyPasswordResetOTP = async (req, res) => {
  try {
    const { identifier, otp } = req.body;

    if (!identifier || !otp) {
      return res.status(400).json({
        success: false,
        message: "Identifier and OTP are required"
      });
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { phone: identifier }
      ]
    }).select("+passwordResetOTP +passwordResetOTPExpires");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.passwordResetOTP || !user.passwordResetOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "No OTP request found"
      });
    }

    if (new Date() > user.passwordResetOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    if (user.passwordResetOTP !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP"
      });
    }

    // Don't delete OTP yet, will be deleted after password reset
    return res.status(200).json({
      success: true,
      message: "OTP verified successfully"
    });

  } catch (error) {
    console.error("Verify password reset OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Error verifying OTP",
      error: error.message
    });
  }
};

// ========== 6️⃣ RESET PASSWORD WITH OTP ==========

const resetPasswordWithOTP = async (req, res) => {
  try {
    const { identifier, otp, newPassword } = req.body;

    if (!identifier || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Identifier, OTP and new password are required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { phone: identifier }
      ]
    }).select("+passwordResetOTP +passwordResetOTPExpires");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.passwordResetOTP || !user.passwordResetOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "No OTP request found"
      });
    }

    if (new Date() > user.passwordResetOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    if (user.passwordResetOTP !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP"
      });
    }

    // Update password (model will hash it)
    user.password = newPassword;
    user.passwordResetOTP = undefined;
    user.passwordResetOTPExpires = undefined;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successful. You can now login with your new password."
    });

  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({
      success: false,
      message: "Error resetting password",
      error: error.message
    });
  }
};

// ========== 7️⃣ LOGOUT ==========

const logout = async (req, res) => {
  try {
    const token = getTokenFromHeader(req);

    if (token) {
      const decoded = jwt.decode(token);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttl = decoded && decoded.exp ? Math.max(0, decoded.exp - nowSeconds) : 0;

      if (redisClient) {
        try {
          await redisClient.set(`bl_${token}`, "1");
          if (ttl > 0) await redisClient.expire(`bl_${token}`, ttl);
        } catch (err) {
          tokenStore.add(token, ttl);
        }
      } else {
        tokenStore.add(token, ttl);
      }
    }

    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const hashedToken = hashToken(refreshToken);
      const decoded = jwt.decode(refreshToken);
      if (decoded?.id) {
        const user = await User.findById(decoded.id);
        if (user) {
          user.refreshTokens = user.refreshTokens.filter(t => t.token !== hashedToken);
          await user.save();
        }
      }
    }

    res.clearCookie("refreshToken", getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: "Logged out successfully"
    });

  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({
      success: false,
      message: "Error during logout"
    });
  }
};

// ========== 8️⃣ REFRESH ACCESS TOKEN ==========

const refreshAccessToken = async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: "Refresh token missing"
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired refresh token"
      });
    }

    if (decoded.type !== "refresh") {
      return res.status(401).json({
        success: false,
        message: "Invalid token type"
      });
    }

    const hashedToken = hashToken(refreshToken);
    const user = await User.findById(decoded.id).select("+refreshTokens.token");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found"
      });
    }

    user.refreshTokens = user.refreshTokens.filter(t => t.expiresAt > new Date());

    const tokenIndex = user.refreshTokens.findIndex(t => t.token === hashedToken);
    if (tokenIndex === -1) {
      return res.status(401).json({
        success: false,
        message: "Refresh token mismatch"
      });
    }

    const newAccessToken = generateAccessToken(user._id, user.userType, user.role);
    const newRefreshToken = generateRefreshToken(user._id);
    const newHashedToken = hashToken(newRefreshToken);

    user.refreshTokens.splice(tokenIndex, 1);
    user.refreshTokens.push({
      token: newHashedToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    res.cookie("refreshToken", newRefreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      accessToken: newAccessToken
    });

  } catch (error) {
    console.error("Refresh token error:", error);
    return res.status(500).json({
      success: false,
      message: "Could not refresh token"
    });
  }
};

// ========== 9️⃣ GET CURRENT USER ==========

const me = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        userType: user.userType,
         role: user.role || user.userType,  // ✅ ADD THIS
        status: user.status,
        isPhoneVerified: user.isPhoneVerified,
         isEmailVerified: user.isEmailVerified,  // ✅ Add this too
        isProfileComplete: user.isProfileComplete  // ✅ Add this too
      }
    });
  } catch (error) {
    console.error('Me error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching profile',
      error: error.message
    });
  }
};

// ========== 🔟 UPDATE PROFILE ==========

const updateProfile = async (req, res) => {
  try {
    const updates = {};
    if (req.body.name) updates.name = req.body.name;
    if (req.body.email) updates.email = req.body.email;
    if (req.body.phone) updates.phone = req.body.phone;

    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};

// ========== 1️⃣1️⃣ CHANGE PASSWORD ==========

const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Old and new passwords are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters'
      });
    }

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isValid = await user.comparePassword(oldPassword);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Old password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error changing password',
      error: error.message
    });
  }
};

// ========== 1️⃣2️⃣ GOOGLE AUTH ==========

const googleAuth = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken || typeof idToken !== "string") {
      return res.status(400).json({
        success: false,
        message: "Valid idToken is required"
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    if (!payload.email || !payload.email_verified) {
      return res.status(400).json({
        success: false,
        message: "Google email not verified"
      });
    }

    const { sub: googleId, email, name = "" } = payload;

    let user = await User.findOne({ email });

    if (user) {
      if (!user.googleId) user.googleId = googleId;
      user.isEmailVerified = true;
      user.status = "active";
    } else {
      user = new User({
        googleId,
        email,
        name,
        isEmailVerified: true,
        status: "active",
        userType: "user",
        registrationMethod: "google"
      });
    }

    const accessToken = generateAccessToken(user._id, user.userType, user.role);
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefreshToken = hashToken(refreshToken);

    user.refreshTokens = user.refreshTokens.filter(t => t.expiresAt > new Date());
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        userType: user.userType
      }
    });

  } catch (error) {
    console.error("[Google Auth Error]", error);
    return res.status(500).json({
      success: false,
      message: "Google authentication failed"
    });
  }
};

// ========== EXPORTS ==========

module.exports = {
  register,
  verifyOTPAndLogin,
  login,
  sendPasswordResetOTP,
  verifyPasswordResetOTP,
  resetPasswordWithOTP,
  logout,
  refreshAccessToken,
  me,
  updateProfile,
  changePassword,
  googleAuth
};