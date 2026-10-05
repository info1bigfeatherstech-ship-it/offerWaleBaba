'use strict';

/**
 * Phase C — after admin approve: send OTP → verify + set password → activate 1-year subscription.
 * Isolated dropshipper collection only (no ecomm User).
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Dropshipper = require('../models/Dropshipper');
const {
  DROPSHIPPER_STATUS,
  SUBSCRIPTION_YEARS,
  SUBSCRIPTION_MS,
  DROPSHIP_CHANNEL,
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  PASSWORD_MIN_LEN,
  BCRYPT_ROUNDS
} = require('../constants/dropshipperAuth');
const { assertEmail, assertPhone } = require('../utils/dropshipperValidators');
const { createDropshipperError } = require('../utils/dropshipperHttp');
const {
  isEmailConfigured,
  sendDropshipperActivationOtpEmail
} = require('../utils/dropshipperEmail');
const { serializeDropshipper } = require('./dropshipperAccount.service');
const logger = require('../../utils/logger');

function otpPepper() {
  return (
    String(process.env.DROPSHIPPER_OTP_PEPPER || '').trim() ||
    String(process.env.JWT_SECRET || '').trim() ||
    'dropshipper-otp-dev-pepper'
  );
}

function hashOtp(code) {
  return crypto.createHmac('sha256', otpPepper()).update(String(code)).digest('hex');
}

function generateOtpCode() {
  const max = 10 ** OTP_LENGTH;
  const n =
    typeof crypto.randomInt === 'function'
      ? crypto.randomInt(0, max)
      : crypto.randomBytes(4).readUInt32BE(0) % max;
  return String(n).padStart(OTP_LENGTH, '0');
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isProd() {
  return (
    String(process.env.NODE_ENV || '').toLowerCase() === 'production' ||
    String(process.env.APP_ENV || '').toLowerCase() === 'production'
  );
}

function otpDebugEnabled() {
  return (
    !isProd() && String(process.env.DROPSHIPPER_OTP_DEBUG || '').toLowerCase() === 'true'
  );
}

function assertPassword(password, confirmPassword) {
  const pwd = String(password || '');
  if (pwd.length < PASSWORD_MIN_LEN) {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      `Password must be at least ${PASSWORD_MIN_LEN} characters`
    );
  }
  if (pwd.length > 128) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Password is too long');
  }
  if (confirmPassword != null && String(confirmPassword) !== pwd) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Passwords do not match');
  }
  // Basic strength: at least one letter and one number
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      'Password must include at least one letter and one number'
    );
  }
  return pwd;
}

async function findPendingOtpDropshipper({ email, phone, dropshipperId } = {}) {
  const filter = { status: DROPSHIPPER_STATUS.PENDING_OTP, channel: DROPSHIP_CHANNEL };

  if (dropshipperId) {
    if (!mongoose.Types.ObjectId.isValid(String(dropshipperId))) {
      throw createDropshipperError(400, 'VALIDATION_ERROR', 'Invalid dropshipperId');
    }
    filter._id = dropshipperId;
  } else if (email) {
    filter.email = assertEmail(email);
  } else if (phone) {
    filter.phone = assertPhone(phone);
  } else {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'email, phone, or dropshipperId is required');
  }

  const doc = await Dropshipper.findOne(filter);
  if (!doc) {
    throw createDropshipperError(
      404,
      'ACTIVATION_NOT_FOUND',
      'No approved dropshipper pending activation for these details'
    );
  }
  return doc;
}

function computeSubscriptionWindow(from = new Date(), planYears = SUBSCRIPTION_YEARS) {
  const startsAt = new Date(from);
  const years = Math.max(1, Number(planYears) || SUBSCRIPTION_YEARS);
  // Prefer calendar years; fallback ms constant matches SUBSCRIPTION_YEARS=1
  const endsAt = new Date(startsAt);
  endsAt.setFullYear(endsAt.getFullYear() + years);
  if (Number.isNaN(endsAt.getTime())) {
    return {
      startsAt,
      endsAt: new Date(startsAt.getTime() + SUBSCRIPTION_MS * years)
    };
  }
  return { startsAt, endsAt };
}

/**
 * Generate + email OTP for pending_otp dropshipper.
 * @param {{ email?: string, phone?: string, dropshipperId?: string }} input
 * @param {{ force?: boolean }} [opts]
 */
async function sendActivationOtp(input = {}, opts = {}) {
  const dropshipper = await findPendingOtpDropshipper(input);
  const now = Date.now();

  if (!opts.force && dropshipper.otp?.lastSentAt) {
    const elapsed = now - new Date(dropshipper.otp.lastSentAt).getTime();
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
      throw createDropshipperError(
        429,
        'OTP_RESEND_COOLDOWN',
        `Please wait ${waitSec}s before requesting another OTP`,
        { retryAfterSeconds: waitSec }
      );
    }
  }

  const code = generateOtpCode();
  dropshipper.otp = {
    codeHash: hashOtp(code),
    expiresAt: new Date(now + OTP_TTL_MS),
    attempts: 0,
    lastSentAt: new Date(now)
  };
  await dropshipper.save();

  let emailed = false;
  if (isEmailConfigured()) {
    await sendDropshipperActivationOtpEmail({
      to: dropshipper.email,
      fullName: dropshipper.fullName,
      otp: code,
      expiresMinutes: Math.round(OTP_TTL_MS / 60000)
    });
    emailed = true;
  } else if (isProd()) {
    throw createDropshipperError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Cannot send OTP: email is not configured on server'
    );
  } else {
    logger.warn('[dropshipperActivate] EMAIL not configured — OTP logged for non-prod', {
      dropshipperId: String(dropshipper._id),
      email: dropshipper.email,
      otp: code
    });
  }

  logger.info('[dropshipperActivate] OTP issued', {
    dropshipperId: String(dropshipper._id),
    emailed
  });

  const payload = {
    success: true,
    message: emailed
      ? 'OTP sent to your registered email'
      : 'OTP generated (email not configured — check server logs in non-prod)',
    dropshipperId: String(dropshipper._id),
    emailMasked: maskEmail(dropshipper.email),
    expiresInSeconds: Math.round(OTP_TTL_MS / 1000),
    channel: DROPSHIP_CHANNEL,
    nextStep: 'complete_activation'
  };

  if (otpDebugEnabled()) {
    payload.debugOtp = code;
  }

  return payload;
}

function maskEmail(email) {
  const s = String(email || '');
  const [user, domain] = s.split('@');
  if (!user || !domain) return '***';
  const visible = user.slice(0, 2);
  return `${visible}***@${domain}`;
}

/**
 * Verify OTP + set password + activate subscription for 1 year.
 * Body: { email|phone|dropshipperId, otp, password, confirmPassword? }
 */
async function completeActivation(body = {}) {
  const otp = String(body.otp || body.code || '').trim();
  if (!/^\d{6}$/.test(otp)) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'OTP must be a 6-digit code');
  }
  const password = assertPassword(body.password, body.confirmPassword);

  const dropshipper = await findPendingOtpDropshipper({
    email: body.email,
    phone: body.phone,
    dropshipperId: body.dropshipperId
  });

  const otpState = dropshipper.otp || {};
  if (!otpState.codeHash || !otpState.expiresAt) {
    throw createDropshipperError(
      400,
      'OTP_NOT_SENT',
      'No active OTP. Request a new activation OTP first.'
    );
  }

  if (new Date(otpState.expiresAt).getTime() <= Date.now()) {
    dropshipper.otp = { codeHash: null, expiresAt: null, attempts: 0, lastSentAt: otpState.lastSentAt };
    await dropshipper.save();
    throw createDropshipperError(400, 'OTP_EXPIRED', 'OTP expired. Request a new one.');
  }

  if (Number(otpState.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    dropshipper.otp = { codeHash: null, expiresAt: null, attempts: 0, lastSentAt: otpState.lastSentAt };
    await dropshipper.save();
    throw createDropshipperError(
      429,
      'OTP_ATTEMPTS_EXCEEDED',
      'Too many invalid OTP attempts. Request a new OTP.'
    );
  }

  const expectedHash = otpState.codeHash;
  const actualHash = hashOtp(otp);
  if (!timingSafeEqualHex(expectedHash, actualHash)) {
    dropshipper.otp.attempts = Number(otpState.attempts || 0) + 1;
    await dropshipper.save();
    const left = OTP_MAX_ATTEMPTS - dropshipper.otp.attempts;
    throw createDropshipperError(400, 'OTP_INVALID', 'Invalid OTP', {
      attemptsRemaining: Math.max(0, left)
    });
  }

  let passwordHash;
  try {
    passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  } catch (hashErr) {
    logger.error('[dropshipperActivate] bcrypt failed', { message: hashErr?.message });
    throw createDropshipperError(500, 'PASSWORD_HASH_FAILED', 'Could not set password');
  }

  const planYears = dropshipper.subscription?.planYears || SUBSCRIPTION_YEARS;
  const { startsAt, endsAt } = computeSubscriptionWindow(new Date(), planYears);

  dropshipper.passwordHash = passwordHash;
  dropshipper.passwordSetAt = new Date();
  dropshipper.status = DROPSHIPPER_STATUS.ACTIVE;
  dropshipper.subscription = dropshipper.subscription || {};
  dropshipper.subscription.planYears = planYears;
  dropshipper.subscription.startsAt = startsAt;
  dropshipper.subscription.endsAt = endsAt;
  dropshipper.otp = {
    codeHash: null,
    expiresAt: null,
    attempts: 0,
    lastSentAt: dropshipper.otp?.lastSentAt || null
  };
  dropshipper.markModified('subscription');
  dropshipper.markModified('otp');

  try {
    await dropshipper.save();
  } catch (err) {
    logger.error('[dropshipperActivate] save failed', { message: err?.message });
    throw createDropshipperError(500, 'ACTIVATION_SAVE_FAILED', 'Failed to activate account');
  }

  logger.info('[dropshipperActivate] Account activated', {
    dropshipperId: String(dropshipper._id),
    startsAt,
    endsAt,
    planYears
  });

  return {
    message: 'Account activated. Your 1-year subscription is now active.',
    dropshipper: serializeDropshipper(dropshipper),
    subscription: {
      startsAt,
      endsAt,
      planYears,
      amountPaidInr: dropshipper.subscription?.amountPaidInr ?? null
    },
    nextStep: 'login',
    channel: DROPSHIP_CHANNEL
  };
}

/**
 * Best-effort OTP send after admin approve (does not fail approve if email fails).
 */
async function trySendOtpAfterApprove(dropshipperId) {
  try {
    if (!dropshipperId) return;
    await sendActivationOtp({ dropshipperId }, { force: true });
  } catch (err) {
    logger.warn('[dropshipperActivate] post-approve OTP send skipped/failed', {
      dropshipperId: String(dropshipperId),
      code: err?.code,
      message: err?.message
    });
  }
}

module.exports = {
  sendActivationOtp,
  completeActivation,
  trySendOtpAfterApprove,
  computeSubscriptionWindow,
  findPendingOtpDropshipper
};
