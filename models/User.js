
// const mongoose = require("mongoose");
// const bcrypt = require("bcrypt");

// const userSchema = new mongoose.Schema(
//   {
//     // ===== BASIC PROFILE =====
//     name: {
//       type: String,
//       trim: true
//     },

//     email: {
//       type: String,
//       lowercase: true,
//       trim: true,
//       index: true,
//       unique: true,
//       sparse: true
//     },

//     phone: {
//       type: String,
//       trim: true,
//       index: true,
//       sparse: true
//     },

//     // ===== PASSWORD =====
//     password: {
//       type: String,
//       minlength: 6,
//       select: false
//     },

//     // ===== GOOGLE AUTH =====
//     googleId: {
//       type: String,
//       index: true,
//       sparse: true
//     },

//     // ===== 🔐 REFRESH TOKEN STORAGE (HASHED) =====
//     refreshTokens: [
//       {
//         token: {
//           type: String,
//           required: true,
//           select: false   // Never expose to queries
//         },
//         createdAt: {
//           type: Date,
//           default: Date.now
//         },
//         expiresAt: {
//           type: Date
//         },
//         deviceInfo: {
//           type: String
//         }
//       }
//     ],

//     // ===== VERIFICATION FLAGS =====
//     isEmailVerified: {
//       type: Boolean,
//       default: false
//     },

//     isPhoneVerified: {
//       type: Boolean,
//       default: false
//     },

//     // ===== OTP STORAGE =====
//     emailVerificationOTP: {
//       type: String,
//       select: false
//     },

//     emailVerificationOTPExpires: {
//       type: Date,
//       select: false
//     },

//     phoneVerificationOTP: {
//       type: String,
//       select: false
//     },

//     phoneVerificationOTPExpires: {
//       type: Date,
//       select: false
//     },

//     // ===== DEVICE SUPPORT =====
//     devices: [
//       {
//         deviceId: String,
//         lastLogin: Date
//       }
//     ],

//     role: {
//       type: String,
//       enum: ["user", "admin"],
//       default: "user"
//     },

//     status: {
//       type: String,
//       enum: ["active", "inactive"],
//       default: "active"
//     }
//   },
//   { timestamps: true }
// );

// // ================= PASSWORD HASH =================
// userSchema.pre("save", async function () {
//   if (!this.isModified("password") || !this.password) return;

//   const salt = await bcrypt.genSalt(12);
//   this.password = await bcrypt.hash(this.password, salt);
// });

// // ================= PASSWORD COMPARE =================
// userSchema.methods.comparePassword = async function (enteredPassword) {
//   return await bcrypt.compare(enteredPassword, this.password);
// };

// module.exports = mongoose.model("User", userSchema);






const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    // ===== BASIC PROFILE =====
    name: {
      type: String,
      trim: true
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
      unique: true,
      sparse: true
    },

    phone: {
      type: String,
      trim: true,
      index: true,
      unique: true,     // phone login ke liye unique hona better hai
      sparse: true
    },

    // ===== PASSWORD =====
    password: {
      type: String,
      minlength: 6,
      select: false
    },

    // ===== GOOGLE AUTH =====
    googleId: {
      type: String,
      index: true,
      sparse: true
    },

    // ===== 🔐 REFRESH TOKEN STORAGE (HASHED) =====
    refreshTokens: [
      {
        token: {
          type: String,
          required: true,
          select: false
        },
        createdAt: {
          type: Date,
          default: Date.now
        },
        expiresAt: {
          type: Date
        },
        deviceInfo: {
          type: String
        }
      }
    ],

    // ===== VERIFICATION FLAGS =====
    isEmailVerified: {
      type: Boolean,
      default: false
    },

    isPhoneVerified: {
      type: Boolean,
      default: false
    },

    // ===== OTP STORAGE =====
    emailVerificationOTP: {
      type: String,
      select: false
    },

    emailVerificationOTPExpires: {
      type: Date,
      select: false
    },

    phoneVerificationOTP: {
      type: String,
      select: false
    },

    phoneVerificationOTPExpires: {
      type: Date,
      select: false
    },

    // ===== 🔐 TRUSTED DEVICES (UPDATED - SECURE) =====
    trustedDevices: [
      {
        deviceId: {
          type: String
        },

        // hashed version of deviceTrustToken (httpOnly cookie)
        deviceTokenHash: {
          type: String,
          select: false
        },

        userAgent: String,
        ipAddress: String,

        addedAt: {
          type: Date,
          default: Date.now
        },

        lastUsedAt: Date,

        expiresAt: Date
      }
    ],

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user"
    },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active"
    }
  },
  { timestamps: true }
);

// ================= PASSWORD HASH =================
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// ================= PASSWORD COMPARE =================
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);