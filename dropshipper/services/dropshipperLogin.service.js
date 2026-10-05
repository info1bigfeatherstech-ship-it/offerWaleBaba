'use strict';

/**
 * Dropshipper login / session (Phase D).
 * Separate from ecomm/wholesale User auth.
 */

const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Dropshipper = require('../models/Dropshipper');
const {
  DROPSHIPPER_STATUS,
  DROPSHIP_CHANNEL
} = require('../constants/dropshipperAuth');
const { assertEmail, assertPhone } = require('../utils/dropshipperValidators');
const { createDropshipperError } = require('../utils/dropshipperHttp');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  ACCESS_EXPIRES,
  REFRESH_EXPIRES
} = require('../utils/dropshipperJwt');
const { serializeDropshipper } = require('./dropshipperAccount.service');
const logger = require('../../utils/logger');

function subscriptionView(doc) {
  const endsAt = doc.subscription?.endsAt ? new Date(doc.subscription.endsAt) : null;
  const startsAt = doc.subscription?.startsAt ? new Date(doc.subscription.startsAt) : null;
  const now = Date.now();
  const active = Boolean(
    doc.status === DROPSHIPPER_STATUS.ACTIVE &&
      endsAt &&
      !Number.isNaN(endsAt.getTime()) &&
      endsAt.getTime() > now
  );
  const expired = Boolean(
    endsAt && !Number.isNaN(endsAt.getTime()) && endsAt.getTime() <= now
  );
  return {
    active,
    expired,
    startsAt: startsAt || null,
    endsAt: endsAt || null,
    planYears: doc.subscription?.planYears ?? null,
    amountPaidInr: doc.subscription?.amountPaidInr ?? null
  };
}

async function findDropshipperForLogin({ email, phone }) {
  if (email) {
    return Dropshipper.findOne({ email: assertEmail(email) });
  }
  if (phone) {
    return Dropshipper.findOne({ phone: assertPhone(phone) });
  }
  throw createDropshipperError(400, 'VALIDATION_ERROR', 'email or phone is required');
}

/**
 * Login with email/phone + password.
 * Allows ACTIVE and EXPIRED (expired can renew later; catalog gated separately).
 */
async function login({ email, phone, password } = {}) {
  const pwd = String(password || '');
  if (!pwd) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'password is required');
  }

  const dropshipper = await findDropshipperForLogin({ email, phone });
  if (!dropshipper || !dropshipper.passwordHash) {
    throw createDropshipperError(401, 'INVALID_CREDENTIALS', 'Invalid email/phone or password');
  }

  if (
    dropshipper.status === DROPSHIPPER_STATUS.REJECTED ||
    dropshipper.status === DROPSHIPPER_STATUS.SUSPENDED ||
    dropshipper.status === DROPSHIPPER_STATUS.PENDING_OTP ||
    dropshipper.status === DROPSHIPPER_STATUS.PENDING_ADMIN ||
    dropshipper.status === DROPSHIPPER_STATUS.PENDING_PAYMENT
  ) {
    throw createDropshipperError(
      403,
      'ACCOUNT_NOT_ACTIVE',
      `Account cannot login (status: ${dropshipper.status})`,
      { status: dropshipper.status }
    );
  }

  // Auto-mark expired if past endsAt but still ACTIVE in DB
  const sub = subscriptionView(dropshipper);
  if (dropshipper.status === DROPSHIPPER_STATUS.ACTIVE && sub.expired) {
    dropshipper.status = DROPSHIPPER_STATUS.EXPIRED;
    try {
      await dropshipper.save();
    } catch (e) {
      logger.warn('[dropshipperLogin] failed to persist expired status', {
        id: String(dropshipper._id),
        message: e?.message
      });
    }
  }

  if (
    dropshipper.status !== DROPSHIPPER_STATUS.ACTIVE &&
    dropshipper.status !== DROPSHIPPER_STATUS.EXPIRED
  ) {
    throw createDropshipperError(
      403,
      'ACCOUNT_NOT_ACTIVE',
      `Account cannot login (status: ${dropshipper.status})`,
      { status: dropshipper.status }
    );
  }

  let match = false;
  try {
    match = await bcrypt.compare(pwd, dropshipper.passwordHash);
  } catch (err) {
    logger.error('[dropshipperLogin] bcrypt compare failed', { message: err?.message });
    throw createDropshipperError(500, 'LOGIN_FAILED', 'Login failed');
  }
  if (!match) {
    throw createDropshipperError(401, 'INVALID_CREDENTIALS', 'Invalid email/phone or password');
  }

  dropshipper.lastLoginAt = new Date();
  await dropshipper.save();

  const accessToken = signAccessToken(dropshipper._id);
  const refreshToken = signRefreshToken(dropshipper._id);
  const subscription = subscriptionView(dropshipper);

  logger.info('[dropshipperLogin] success', {
    dropshipperId: String(dropshipper._id),
    subscriptionActive: subscription.active
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_EXPIRES,
    refreshExpiresIn: REFRESH_EXPIRES,
    tokenType: 'Bearer',
    channel: DROPSHIP_CHANNEL,
    portal: 'dropshipper',
    dropshipper: serializeDropshipper(dropshipper),
    subscription,
    panelAccess: {
      catalog: subscription.active,
      orders: subscription.active,
      renewRequired: !subscription.active
    },
    nextStep: subscription.active ? 'panel' : 'renew'
  };
}

async function refreshSession(refreshToken) {
  const decoded = verifyRefreshToken(refreshToken);
  if (!mongoose.Types.ObjectId.isValid(String(decoded.id))) {
    throw createDropshipperError(401, 'INVALID_TOKEN', 'Invalid refresh token subject');
  }
  const dropshipper = await Dropshipper.findById(decoded.id);
  if (!dropshipper) {
    throw createDropshipperError(401, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper not found');
  }
  if (
    dropshipper.status !== DROPSHIPPER_STATUS.ACTIVE &&
    dropshipper.status !== DROPSHIPPER_STATUS.EXPIRED
  ) {
    throw createDropshipperError(403, 'ACCOUNT_NOT_ACTIVE', 'Account cannot refresh session');
  }

  const sub = subscriptionView(dropshipper);
  if (dropshipper.status === DROPSHIPPER_STATUS.ACTIVE && sub.expired) {
    dropshipper.status = DROPSHIPPER_STATUS.EXPIRED;
    await dropshipper.save();
  }

  return {
    accessToken: signAccessToken(dropshipper._id),
    refreshToken: signRefreshToken(dropshipper._id),
    expiresIn: ACCESS_EXPIRES,
    refreshExpiresIn: REFRESH_EXPIRES,
    tokenType: 'Bearer',
    dropshipper: serializeDropshipper(dropshipper),
    subscription: subscriptionView(dropshipper),
    channel: DROPSHIP_CHANNEL
  };
}

async function getMe(dropshipperId) {
  if (!dropshipperId || !mongoose.Types.ObjectId.isValid(String(dropshipperId))) {
    throw createDropshipperError(401, 'UNAUTHORIZED', 'Not authenticated');
  }
  const dropshipper = await Dropshipper.findById(dropshipperId);
  if (!dropshipper) {
    throw createDropshipperError(401, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper not found');
  }
  const subscription = subscriptionView(dropshipper);
  if (dropshipper.status === DROPSHIPPER_STATUS.ACTIVE && subscription.expired) {
    dropshipper.status = DROPSHIPPER_STATUS.EXPIRED;
    await dropshipper.save();
  }
  return {
    dropshipper: serializeDropshipper(dropshipper),
    subscription: subscriptionView(dropshipper),
    panelAccess: {
      catalog: subscriptionView(dropshipper).active,
      orders: subscriptionView(dropshipper).active,
      renewRequired: !subscriptionView(dropshipper).active
    },
    channel: DROPSHIP_CHANNEL
  };
}

module.exports = {
  login,
  refreshSession,
  getMe,
  subscriptionView
};
