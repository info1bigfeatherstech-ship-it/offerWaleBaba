/**
 * Staff Management Controller
 * Access: Admin only
 * 
 * @version 4.0.0 - No Cache for Admin Panel
 */

const User = require('../models/User');
const { validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
// ❌ REMOVE cache imports
// const cacheService = require('../services/cache.service');
// const cacheConfig = require('../config/cache.config');

// ==============================
// CONSTANTS
// ==============================
const ALLOWED_STAFF_ROLES = ['product_manager', 'order_manager', 'marketing_manager'];

// ==============================
// GENERATE RANDOM PASSWORD
// ==============================
const generateRandomPassword = () => {
  const length = 10;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  let password = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    password += charset[randomIndex];
  }
  return password;
};

// ==============================
// BUILD STAFF QUERY
// ==============================
const buildStaffQuery = (search, role) => {
  const query = {
    role: { $ne: 'user', $in: ALLOWED_STAFF_ROLES }
  };

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } }
    ];
  }

  if (role && ALLOWED_STAFF_ROLES.includes(role)) {
    query.role = role;
  }

  return query;
};

// ==============================
// 1️⃣ GET ALL STAFF (NO CACHE - Real-time)
// ==============================
const getAllStaff = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { search = '', role = '' } = req.query;

    const query = buildStaffQuery(search, role);
    
    const [staff, total] = await Promise.all([
      User.find(query)
        .select('name email phone role userType status createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      message: 'Staff fetched successfully',
      data: {
        staff,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (error) {
    console.error('[StaffController] getAllStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// 2️⃣ CREATE STAFF
// ==============================
const createStaff = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { name, email, phone, password, role } = req.body;

    if (!ALLOWED_STAFF_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Allowed roles: ${ALLOWED_STAFF_ROLES.join(', ')}`
      });
    }

    const [existingEmail, existingPhone] = await Promise.all([
      User.findOne({ email }),
      User.findOne({ phone })
    ]);

    if (existingEmail) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    if (existingPhone) {
      return res.status(409).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    const staff = new User({
      name,
      email,
      phone,
      password,
      role,
      userType: 'user',
      isEmailVerified: true,
      isPhoneVerified: true,
      isProfileComplete: true,
      status: 'active',
      registrationMethod: 'email'
    });

    await staff.save();

    const staffData = {
      _id: staff._id,
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      role: staff.role,
      userType: staff.userType,
      status: staff.status,
      createdAt: staff.createdAt,
      updatedAt: staff.updatedAt
    };

    return res.status(201).json({
      success: true,
      message: 'Staff created successfully',
      data: staffData
    });
  } catch (error) {
    console.error('[StaffController] createStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// 3️⃣ GET STAFF BY ID (NO CACHE)
// ==============================
const getStaffById = async (req, res) => {
  try {
    const { id } = req.params;

    const staff = await User.findById(id)
      .select('name email phone role userType status createdAt updatedAt')
      .lean();

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    if (staff.role === 'user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Cannot view regular users.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Staff fetched successfully',
      data: staff
    });
  } catch (error) {
    console.error('[StaffController] getStaffById Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// 4️⃣ UPDATE STAFF
// ==============================
const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, role, status } = req.body;

    if (id === req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot modify your own account. Use profile settings.'
      });
    }

    const staff = await User.findById(id);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (phone) updates.phone = phone;
    
    if (role) {
      if (!ALLOWED_STAFF_ROLES.includes(role)) {
        return res.status(400).json({
          success: false,
          message: `Invalid role. Allowed roles: ${ALLOWED_STAFF_ROLES.join(', ')}`
        });
      }
      updates.role = role;
    }
    
    if (status) {
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Status must be active or inactive'
        });
      }
      updates.status = status;
    }

    const updatedStaff = await User.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('name email phone role userType status createdAt updatedAt')
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Staff updated successfully',
      data: updatedStaff
    });
  } catch (error) {
    console.error('[StaffController] updateStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// 5️⃣ RESET STAFF PASSWORD
// ==============================
const resetStaffPassword = async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot reset your own password. Use change password.'
      });
    }

    const staff = await User.findById(id);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    const newPassword = generateRandomPassword();
    
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    staff.password = hashedPassword;
    await staff.save();

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully',
      ...(process.env.NODE_ENV === 'development' && { newPassword })
    });
  } catch (error) {
    console.error('[StaffController] resetStaffPassword Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reset password',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// 6️⃣ DELETE STAFF
// ==============================
const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    const staff = await User.findByIdAndDelete(id);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Staff deleted successfully'
    });
  } catch (error) {
    console.error('[StaffController] deleteStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// 7️⃣ GET ADMIN PROFILE
// ==============================
const getAdminProfile = async (req, res) => {
  try {
    const admin = await User.findById(req.userId)
      .select('name email phone role userType status createdAt updatedAt')
      .lean();

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile fetched successfully',
      data: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
        role: admin.role,
        userType: admin.userType,
        status: admin.status,
        createdAt: admin.createdAt,
        updatedAt: admin.updatedAt
      }
    });
  } catch (error) {
    console.error('[StaffController] getAdminProfile Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// 8️⃣ UPDATE ADMIN PROFILE
// ==============================
const updateOwnProfile = async (req, res) => {
  try {
    const { name, phone } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (phone) updates.phone = phone;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    const admin = await User.findByIdAndUpdate(
      req.userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('name email phone role userType status');

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: admin
    });
  } catch (error) {
    console.error('[StaffController] updateOwnProfile Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  getAllStaff,
  createStaff,
  getStaffById,
  updateStaff,
  resetStaffPassword,
  deleteStaff,
  getAdminProfile,
  updateOwnProfile
};