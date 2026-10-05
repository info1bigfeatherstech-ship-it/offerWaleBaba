'use strict';

/**
 * Dropshipper panel access gate (Phase D).
 * Primary: Dropshipper JWT (portal=dropshipper).
 * Staff JWT no longer unlocks catalog/orders (replaced).
 * Non-prod bypass: DROPSHIPPER_AUTH_BYPASS=true still allowed for local only.
 */

const Dropshipper = require('../models/Dropshipper');
const {
  DROPSHIPPER_STATUS,
  DROPSHIP_CHANNEL
} = require('../constants/dropshipperAuth');
const {
  verifyAccessToken,
  extractBearerToken
} = require('../utils/dropshipperJwt');
const { respondError } = require('../utils/dropshipperHttp');
const tokenStore = require('../../config/tokenBlacklist');
const redisManager = require('../../config/redis.config');
const logger = require('../../utils/logger');

async function isTokenBlacklisted(token) {
  try {
    const redis = redisManager.getRedisClient?.() || null;
    if (redis) {
      const hit = await redis.get(`bl_ds_${token}`);
      if (hit) return true;
    }
  } catch (_) {
    // fall through to memory
  }
  return tokenStore.has(`ds:${token}`) || tokenStore.has(token);
}

async function blacklistToken(token, ttlSeconds = 7 * 24 * 3600) {
  try {
    const redis = redisManager.getRedisClient?.() || null;
    if (redis) {
      await redis.setex(`bl_ds_${token}`, Math.max(60, ttlSeconds), '1');
      return;
    }
  } catch (err) {
    logger.warn('[dropshipperAccess] redis blacklist failed', { message: err?.message });
  }
  tokenStore.add(`ds:${token}`, ttlSeconds);
}

function isProd() {
  return (
    String(process.env.NODE_ENV || '').toLowerCase() === 'production' ||
    String(process.env.APP_ENV || '').toLowerCase() === 'production'
  );
}

function subscriptionActive(doc) {
  if (!doc || doc.status !== DROPSHIPPER_STATUS.ACTIVE) return false;
  const ends = doc.subscription?.endsAt ? new Date(doc.subscription.endsAt) : null;
  if (!ends || Number.isNaN(ends.getTime())) return false;
  return ends.getTime() > Date.now();
}

/**
 * Require authenticated dropshipper (login OK even if subscription expired).
 */
async function requireDropshipperAccess(req, res, next) {
  try {
    const bypass = String(process.env.DROPSHIPPER_AUTH_BYPASS || '').toLowerCase() === 'true';
    if (bypass && !isProd()) {
      req.dropshipperAccess = { mode: 'bypass', subscriptionActive: true };
      req.dropshipperId = null;
      req.userId = null;
      return next();
    }

    const token = extractBearerToken(req);
    if (!token) {
      return respondError(res, 401, 'MISSING_AUTH_HEADER', 'Dropshipper login required');
    }

    if (await isTokenBlacklisted(token)) {
      return respondError(res, 401, 'TOKEN_BLACKLISTED', 'Token is blacklisted');
    }

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      return respondError(
        res,
        err.statusCode || 401,
        err.code || 'INVALID_TOKEN',
        err.message || 'Invalid token'
      );
    }

    const dropshipper = await Dropshipper.findById(decoded.id);
    if (!dropshipper) {
      return respondError(res, 401, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper not found');
    }

    if (
      dropshipper.status === DROPSHIPPER_STATUS.REJECTED ||
      dropshipper.status === DROPSHIPPER_STATUS.SUSPENDED ||
      dropshipper.status === DROPSHIPPER_STATUS.PENDING_OTP ||
      dropshipper.status === DROPSHIPPER_STATUS.PENDING_ADMIN ||
      dropshipper.status === DROPSHIPPER_STATUS.PENDING_PAYMENT
    ) {
      return respondError(
        res,
        403,
        'ACCOUNT_NOT_ACTIVE',
        `Account cannot access panel (status: ${dropshipper.status})`
      );
    }

    // Persist expired transition
    if (dropshipper.status === DROPSHIPPER_STATUS.ACTIVE && !subscriptionActive(dropshipper)) {
      dropshipper.status = DROPSHIPPER_STATUS.EXPIRED;
      try {
        await dropshipper.save();
      } catch (_) {
        /* non-fatal */
      }
    }

    const active = subscriptionActive(dropshipper);

    req.dropshipperAccess = {
      mode: 'dropshipper',
      dropshipperId: String(dropshipper._id),
      subscriptionActive: active,
      status: dropshipper.status
    };
    req.dropshipper = dropshipper;
    req.dropshipperId = String(dropshipper._id);
    // Orders path historically used req.userId — map to dropshipper id for ownership
    req.userId = String(dropshipper._id);
    req.authPortal = 'dropshipper';
    req.authChannel = DROPSHIP_CHANNEL;
    req.dropshipperToken = token;

    return next();
  } catch (err) {
    logger.error('[dropshipperAccess] unexpected', { message: err?.message });
    return respondError(res, 500, 'AUTH_ERROR', 'Error verifying dropshipper token');
  }
}

/**
 * Catalog / orders / serviceability — requires active paid subscription year.
 * Login + /auth/me remain available when expired (renew UX).
 */
function requireActiveSubscription(req, res, next) {
  if (req.dropshipperAccess?.mode === 'bypass') {
    return next();
  }
  if (req.dropshipperAccess?.subscriptionActive === true) {
    return next();
  }
  return respondError(
    res,
    403,
    'SUBSCRIPTION_EXPIRED',
    'Your subscription has expired. Renew to access catalog and orders.',
    { nextStep: 'renew' }
  );
}

module.exports = {
  requireDropshipperAccess,
  requireActiveSubscription,
  blacklistToken,
  isTokenBlacklisted,
  subscriptionActive
};
