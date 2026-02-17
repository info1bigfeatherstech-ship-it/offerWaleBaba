const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email'
      ]
    },
    password: {
      type: String,
      required: [true, 'Please provide a password'],
      minlength: 6,
      select: false // Don't return password by default
    },
    profile: {
      firstname: {
        type: String,
        required: [true, 'Please provide a first name'],
        trim: true
      },
      lastname: {
        type: String,
        required: false,
        trim: true
      },
      phone: {
        type: String,
        required: false,
        trim: true
      }
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user'
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    }
    ,
    passwordResetOTP: {
      type: String,
      select: false
    },
    passwordResetOTPExpires: {
      type: Date,
      select: false
    }
    ,
    isVerified: {
      type: Boolean,
      default: false
    },
    emailVerificationOTP: {
      type: String,
      select: false
    },
    emailVerificationOTPExpires: {
      type: Date,
      select: false
    }
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre('save', async function () {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) {
    return;
  }

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (error) {
    // Throw to let Mongoose handle the error for async middleware
    throw error;
  }
});

// Method to compare passwords
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;
