'use strict';

/**
 * Dropshipper account — separate collection from ecomm/wholesale User.
 * Never store dropshipper credentials on the User model.
 */

const mongoose = require('mongoose');
const {
  DROPSHIPPER_STATUS,
  SUBSCRIPTION_YEARS
} = require('../constants/dropshipperAuth');

const subscriptionSchema = new mongoose.Schema(
  {
    amountPaidInr: { type: Number, min: 0, default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null, index: true },
    lastPaymentId: { type: String, trim: true, default: null },
    lastRazorpayOrderId: { type: String, trim: true, default: null },
    planYears: { type: Number, default: SUBSCRIPTION_YEARS, min: 1 },
    renewedAt: { type: Date, default: null }
  },
  { _id: false }
);

const otpSchema = new mongoose.Schema(
  {
    codeHash: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastSentAt: { type: Date, default: null }
  },
  { _id: false }
);

const dropshipperSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 180
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{10}$/, 'Phone must be a 10-digit Indian mobile number']
    },
    businessName: { type: String, trim: true, maxlength: 160, default: null },

    whatsappNumber: {
      type: String,
      trim: true,
      default: null,
      match: [/^\d{10}$/, 'WhatsApp must be a 10-digit Indian mobile number']
    },
    application: {
      permanentAddress: { type: String, trim: true, maxlength: 500, default: '' },
      haveShop: { type: Boolean, default: false },
      businessAddress: { type: String, trim: true, maxlength: 500, default: '' },
      deliveryAddress: { type: String, trim: true, maxlength: 500, default: '' },
      sellingPlaceFrom: { type: String, trim: true, maxlength: 160, default: '' },
      sellingZoneCity: { type: String, trim: true, maxlength: 120, default: '' },
      productCategory: { type: String, trim: true, maxlength: 160, default: '' },
      monthlyEstimatedPurchase: { type: Number, default: null, min: 0 },
      idProofUrl: { type: String, trim: true, maxlength: 500, default: '' },
      businessAddressProofUrl: { type: String, trim: true, maxlength: 500, default: '' }
    },

    passwordHash: { type: String, default: null },

    status: {
      type: String,
      enum: Object.values(DROPSHIPPER_STATUS),
      default: DROPSHIPPER_STATUS.PENDING_ADMIN,
      index: true
    },

    subscription: { type: subscriptionSchema, default: () => ({}) },

    otp: { type: otpSchema, default: () => ({}) },

    /** Link back to registration request that created this account */
    registrationRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DropshipperRegistrationRequest',
      default: null,
      index: true
    },

    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionNote: { type: String, trim: true, maxlength: 500, default: null },

    lastLoginAt: { type: Date, default: null },
    passwordSetAt: { type: Date, default: null },

    /**
     * Commerce channel for this actor — always dropship.
     * Not an ecomm/wholesale storefront scope field.
     */
    channel: { type: String, default: 'dropship', immutable: true }
  },
  { timestamps: true }
);

dropshipperSchema.index({ email: 1 }, { unique: true });
dropshipperSchema.index({ phone: 1 }, { unique: true });
dropshipperSchema.index({ status: 1, createdAt: -1 });
dropshipperSchema.index({ 'subscription.endsAt': 1, status: 1 });

dropshipperSchema.methods.hasActiveSubscription = function hasActiveSubscription(at = new Date()) {
  if (this.status !== DROPSHIPPER_STATUS.ACTIVE) return false;
  const ends = this.subscription?.endsAt ? new Date(this.subscription.endsAt) : null;
  if (!ends || Number.isNaN(ends.getTime())) return false;
  return ends.getTime() > at.getTime();
};

module.exports = mongoose.model('Dropshipper', dropshipperSchema);
