const User = require('../models/User');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { validationResult } = require('express-validator');
const { redisClient } = require('../config/redis.config');
const tokenStore = require('../config/tokenBlacklist');
const { token } = require('morgan');
const crypto = require('crypto');


const { sendOTP } = require("../services/otp.service");



// Helper to extract token from Authorization header
// Validate required secrets at startup
const getTokenFromHeader = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
};

// Configure nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER ,
    pass: process.env.EMAIL_PASSWORD 
  }
});

// Generate Access and Refresh Tokens
if (!process.env.JWT_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
  throw new Error('JWT secrets are not configured');
}
const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';

// Generate Access Token
const generateAccessToken = (id) => {
  return jwt.sign(
    { id, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
};

// Generate Refresh Token
const generateRefreshToken = (id) => {
  return jwt.sign(
    { id, type: 'refresh' },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_EXPIRES }
  );
};

// Hash Refresh Token before storing
const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const getRefreshCookieOptions = () => {
  const secure = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/api/auth/refresh', // restrict usage
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
};

// Google OAuth2 client (verify id tokens from frontend)
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID || 'NO_CLIENT_ID_SET'
);

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

    const { email, password, name, phone } = req.body;

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
      existingUser.name = name || existingUser.name;
      if (phone) existingUser.phone = phone;
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
       name, 
       phone ,
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

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required"
      });
    }

    const user = await User.findOne({ email })
      .select("+emailVerificationOTP +emailVerificationOTPExpires");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "User already verified. Please login."
      });
    }

    if (!user.emailVerificationOTP || !user.emailVerificationOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "No verification request found"
      });
    }

    if (user.emailVerificationOTP !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP"
      });
    }

    if (new Date() > user.emailVerificationOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired"
      });
    }

    //  Activate user
    user.isEmailVerified = true;
    user.status = "active";
    user.emailVerificationOTP = undefined;
    user.emailVerificationOTPExpires = undefined;

    //  Generate tokens
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const hashedRefreshToken = hashToken(refreshToken);

    //  Remove expired tokens
    user.refreshTokens = user.refreshTokens.filter(
      (t) => t.expiresAt > new Date()
    );

    //  Store hashed refresh token
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    //  Send refresh token in cookie
    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: "Verification successful",
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });

  } catch (error) {
    console.error("Verify registration OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Error verifying OTP"
    });
  }
};

// Login Controller
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
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    //  Check verification + active status
    if (!user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        message: "Account not verified. Please verify email."
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
        message: "Invalid email or password"
      });
    }

    //  Generate tokens
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const hashedRefreshToken = hashToken(refreshToken);

    //  Remove expired tokens
    // user.refreshTokens = user.refreshTokens.filter(
    //   (t) => t.expiresAt > new Date()
    // );
    if (!Array.isArray(user.refreshTokens)) {
  user.refreshTokens = [];
}
    user.refreshTokens = user.refreshTokens.filter(
  (t) => t.token && t.expiresAt && t.expiresAt > new Date()
);

    //  Store hashed refresh token
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    //  Set refresh token cookie
    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: "Login successful",
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Error during login"
    });
  }
};

// Logout (blacklist token)
const logout = async (req, res) => {
  try {
    // ===== 1️⃣ BLACKLIST ACCESS TOKEN =====
    const token = getTokenFromHeader(req);

    if (token) {
      const decoded = jwt.decode(token);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttl = decoded && decoded.exp
        ? Math.max(0, decoded.exp - nowSeconds)
        : 0;

      if (redisClient) {
        try {
          await redisClient.set(`bl_${token}`, "1");
          if (ttl > 0) {
            await redisClient.expire(`bl_${token}`, ttl);
          }
        } catch (err) {
          tokenStore.add(token, ttl);
        }
      } else {
        tokenStore.add(token, ttl);
      }
    }

    // ===== 2️⃣ REMOVE REFRESH TOKEN FROM DB =====
    const refreshToken = req.cookies?.refreshToken;

    if (refreshToken) {
      const hashedToken = hashToken(refreshToken);

      // Decode to get user id (no need to verify here)
      const decoded = jwt.decode(refreshToken);

      if (decoded?.id) {
        const user = await User.findById(decoded.id);

        if (user) {
          user.refreshTokens = user.refreshTokens.filter(
            (t) => t.token !== hashedToken
          );
          await user.save();
        }
      }
    }

    // ===== 3️⃣ CLEAR COOKIE =====
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


// Refresh access token using refresh token cookie (Production Safe Version)
const refreshAccessToken = async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: "Refresh token missing"
      });
    }

    //  Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(
        refreshToken,
        process.env.REFRESH_TOKEN_SECRET
      );
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

    //  Find user first
    const user = await User.findById(decoded.id).select("+refreshTokens.token");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found"
      });
    }

    //  Remove expired tokens
    user.refreshTokens = user.refreshTokens.filter(
      (t) => t.expiresAt > new Date()
    );

    //  Check if hashed token exists in array
    const tokenIndex = user.refreshTokens.findIndex(
      (t) => t.token === hashedToken
    );

    if (tokenIndex === -1) {
      return res.status(401).json({
        success: false,
        message: "Refresh token mismatch (possible reuse detected)"
      });
    }

    //  ROTATE TOKEN
    const newAccessToken = generateAccessToken(user._id);
    const newRefreshToken = generateRefreshToken(user._id);
    const newHashedToken = hashToken(newRefreshToken);

    //  Remove old refresh token
    user.refreshTokens.splice(tokenIndex, 1);

    //  Add new refresh token
    user.refreshTokens.push({
      token: newHashedToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    //  Send new refresh token in cookie
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
        name: user.name,
        phone: user.phone,
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
    const allowed = ['name', 'phone', 'email'];
    const updates = {};

    if (req.body.email) updates.email = req.body.email;
    if (req.body.name) updates.name = req.body.name;
    if (req.body.phone) updates.phone = req.body.phone;

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

// Google Sign-In (pass idToken from frontend)
// ===== GOOGLE AUTH CONTROLLER =====
const googleAuth = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken || typeof idToken !== "string") {
      return res.status(400).json({
        success: false,
        message: "Valid idToken is required"
      });
    }

    //  Verify with Google
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

    // ===== FIND OR CREATE USER =====
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
        role: "user"
      });
    }

    // ===== GENERATE TOKENS =====
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const hashedRefreshToken = hashToken(refreshToken);

    //  Remove expired tokens
    user.refreshTokens = user.refreshTokens.filter(
      (t) => t.expiresAt > new Date()
    );

    //  Push new refresh token
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    await user.save();

    //  Send refresh token in cookie
    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        role: user.role
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




const requestPhoneOTP = async (req, res) => {
    try {

    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({
        message: "All fields are required"
      });
    }

    let user = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (user && user.isPhoneVerified) {
      return res.status(400).json({
        message: "User already registered. Please login."
      });
    }

    const otp = generateOTP();
    await sendOTP(phone, otp);

    const hashedOTP = await bcrypt.hash(otp, 10);

    if (user && !user.isPhoneVerified) {

      user.phoneVerificationOTP = hashedOTP;
      user.phoneVerificationOTPExpires = Date.now() + 5 * 60 * 1000;

      await user.save();

      return res.json({
        message: "OTP resent successfully",
           otp: otp
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    user = new User({
      name,
      email,
      phone,
      password: hashedPassword,
      isPhoneVerified: false,
      phoneVerificationOTP: hashedOTP,
      phoneVerificationOTPExpires: Date.now() + 5 * 60 * 1000
    });

    await user.save();
  
    res.json({
      message: "OTP sent successfully",
      otp: otp
    });

  } catch (error) {

    res.status(500).json({
      message: "Registration failed",
      error: error.message
    });

  }
};

//verify phone OTP
const verifyPhoneOTP = async (req, res) => {
   try {

    const { phone, otp } = req.body;

    const user = await User.findOne({ phone })
      .select("+phoneVerificationOTP +phoneVerificationOTPExpires +refreshTokens");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.phoneVerificationOTPExpires < Date.now()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    const match = await bcrypt.compare(otp, user.phoneVerificationOTP);

    if (!match) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    user.isPhoneVerified = true;

    user.phoneVerificationOTP = undefined;
    user.phoneVerificationOTPExpires = undefined;

    //  Generate tokens
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const hashedRefreshToken = hashToken(refreshToken);

    //  Remove expired tokens
    user.refreshTokens = user.refreshTokens.filter(
      (t) => t.expiresAt > new Date()
    );

    //  Store hashed refresh token
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    //  Send refresh token in cookie
    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    res.json({
      message: "Phone verified",
      accessToken
    });

  } catch (error) {

    console.error("Phone OTP verification error:", error);
    res.status(500).json({
      message: "OTP verification failed"
    });

  }
};


//login with number and password
const loginWithPhone=async(req, res)=>{
    try {

    // const { phone, email, password } = req.body;
      const phone = req.body.phone?.trim();
      const password = req.body.password?.trim();
      const email = req.body.email;

      // const query = phone ? { phone } : { email };

    const user = await User.findOne({phone: phone })
      .select("+password +refreshTokens");
   
       console.log("testingg 2");
       console.log("User found:", user);

    if (!user) {
      return res.status(400).json({
        message: "User not found"
      });
    }

    if (!user.isPhoneVerified) {
      return res.status(403).json({
        message: "Phone number not verified"
      });
    } 
// console.log("Entered password:", password);
// console.log("Entered length:", password.length);

// console.log("Stored hash:", user.password);

// console.log("Password JSON:", JSON.stringify(password));
 
    
    // const isMatch = await user.comparePassword(password);

 const isMatch = await bcrypt.compare(password, user.password);

    console.log("isMatch:", isMatch);
    if (!isMatch) {
      return res.status(400).json({
        message: "password match nahin hua"
      });
    }

    // 🔐 Generate tokens
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const hashedRefreshToken = hashToken(refreshToken);

    // 🧹 Remove expired tokens
    user.refreshTokens = user.refreshTokens.filter(
      (t) => t.expiresAt > new Date()
    );

    // ➕ Store hashed refresh token
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await user.save();

    // 🍪 Send refresh token in cookie
    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());

    res.json({
      message: "Login successful",
      accessToken
    });

  } catch (error) {

    res.status(500).json({
      message: "Login failed"
    });

  }
}


module.exports = { register, login, logout, me, updateProfile, changePassword, forgotPassword, resetPassword, verifyRegistrationOTP, refreshAccessToken, googleAuth , requestPhoneOTP, verifyPhoneOTP, loginWithPhone };

