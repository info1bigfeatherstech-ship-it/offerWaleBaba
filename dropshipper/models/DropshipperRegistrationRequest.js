'use strict';

/**
 * Paid registration / renew request awaiting (or decided by) admin.
 * Separate from ecomm User and from Dropshipper account until approved.
 */

const mongoose = require('mongoose');
const {
  REQUEST_ADMIN_STATUS,
  REQUEST_PAYMENT_STATUS
} = require('../constants/dropshipperAuth');

const paymentSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: Object.values(REQUEST_PAYMENT_STATUS),
      default: REQUEST_PAYMENT_STATUS.CREATED
    },
    razorpayOrderId: { type: String, trim: true, default: null, index: true },
    razorpayPaymentId: { type: String, trim: true, default: null, index: true },
    razorpaySignature: { type: String, trim: true, default: null },
    amountPaise: { type: Number, min: 0, default: null },
    currency: { type: String, default: 'INR' },
    paidAt: { type: Date, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const registrationRequestSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 180,
      index: true
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{10}$/, 'Phone must be a 10-digit Indian mobile number'],
      index: true
    },
    businessName: { type: String, trim: true, maxlength: 160, default: null },

    /** Same application profile wholesaler KYC collects (dropship channel only). */
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

    /**
     * Fee snapshot at payment time — later admin price changes must not alter this.
     */
    amountDueInr: { type: Number, required: true, min: 1 },
    amountPaidInr: { type: Number, default: 0, min: 0 },

    /** Hardcoded plan length captured at request time (always 1 for now). */
    planYears: { type: Number, required: true, min: 1, default: 1 },

    kind: {
      type: String,
      enum: ['registration', 'renewal'],
      default: 'registration',
      index: true
    },

    payment: { type: paymentSchema, default: () => ({}) },

    adminStatus: {
      type: String,
      enum: Object.values(REQUEST_ADMIN_STATUS),
      default: REQUEST_ADMIN_STATUS.PENDING,
      index: true
    },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },

    dropshipperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dropshipper',
      default: null,
      index: true
    },

    channel: { type: String, default: 'dropship', immutable: true }
  },
  { timestamps: true }
);

registrationRequestSchema.index({ adminStatus: 1, createdAt: -1 });
registrationRequestSchema.index(
  { 'payment.razorpayOrderId': 1 },
  { unique: true, sparse: true }
);
registrationRequestSchema.index(
  { 'payment.razorpayPaymentId': 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model(
  'DropshipperRegistrationRequest',
  registrationRequestSchema
);
