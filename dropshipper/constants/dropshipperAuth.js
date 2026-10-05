'use strict';

/**
 * Dropshipper auth / subscription constants.
 * Isolated from ecomm/wholesale storefront enums — do not mix channels.
 */

/** Hardcoded plan length until admin duration options ship later. */
const SUBSCRIPTION_YEARS = 1;

const SUBSCRIPTION_MS = SUBSCRIPTION_YEARS * 365 * 24 * 60 * 60 * 1000;

const DEFAULT_SUBSCRIPTION_AMOUNT_INR = 800;

const DROPSHIPPER_STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment',
  PENDING_ADMIN: 'pending_admin',
  PENDING_OTP: 'pending_otp',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended'
});

const REQUEST_ADMIN_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

const REQUEST_PAYMENT_STATUS = Object.freeze({
  CREATED: 'created',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded'
});

/** Settings singleton key — not an ecomm/wholesale storefront. */
const SETTINGS_DOC_KEY = 'dropshipper_global';

/**
 * Channel tag for dropshipper-owned commerce (orders already use storefront:'dropship').
 * Auth/settings must never write ecomm|wholesale storefront values.
 */
const DROPSHIP_CHANNEL = 'dropship';

/** Phase C — activation OTP / password */
const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const PASSWORD_MIN_LEN = 8;
const BCRYPT_ROUNDS = 12;

module.exports = {
  SUBSCRIPTION_YEARS,
  SUBSCRIPTION_MS,
  DEFAULT_SUBSCRIPTION_AMOUNT_INR,
  DROPSHIPPER_STATUS,
  REQUEST_ADMIN_STATUS,
  REQUEST_PAYMENT_STATUS,
  SETTINGS_DOC_KEY,
  DROPSHIP_CHANNEL,
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  PASSWORD_MIN_LEN,
  BCRYPT_ROUNDS
};
