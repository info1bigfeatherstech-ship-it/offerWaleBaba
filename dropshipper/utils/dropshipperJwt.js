'use strict';

/**
 * Dropshipper JWT helpers — portal/channel isolated from ecomm/admin tokens.
 * Uses JWT_SECRET / REFRESH_TOKEN_SECRET but claims portal=dropshipper so
 * ecomm verifyToken (User lookup) will not accidentally authorize panel routes.
 */

const jwt = require('jsonwebtoken');
const { DROPSHIP_CHANNEL } = require('../constants/dropshipperAuth');
const { createDropshipperError } = require('./dropshipperHttp');

const PORTAL = 'dropshipper';
const ACCESS_EXPIRES = process.env.DROPSHIPPER_ACCESS_TOKEN_EXPIRES || '7d';
const REFRESH_EXPIRES = process.env.DROPSHIPPER_REFRESH_TOKEN_EXPIRES || '30d';

function getAccessSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) {
    throw createDropshipperError(503, 'JWT_NOT_CONFIGURED', 'JWT_SECRET is not configured');
  }
  return secret;
}

function getRefreshSecret() {
  const secret = String(
    process.env.DROPSHIPPER_REFRESH_TOKEN_SECRET ||
      process.env.REFRESH_TOKEN_SECRET ||
      process.env.JWT_SECRET ||
      ''
  ).trim();
  if (!secret) {
    throw createDropshipperError(503, 'JWT_NOT_CONFIGURED', 'Refresh token secret is not configured');
  }
  return secret;
}

function signAccessToken(dropshipperId) {
  return jwt.sign(
    {
      id: String(dropshipperId),
      type: 'access',
      role: 'dropshipper',
      portal: PORTAL,
      channel: DROPSHIP_CHANNEL
    },
    getAccessSecret(),
    { expiresIn: ACCESS_EXPIRES }
  );
}

function signRefreshToken(dropshipperId) {
  return jwt.sign(
    {
      id: String(dropshipperId),
      type: 'refresh',
      portal: PORTAL,
      channel: DROPSHIP_CHANNEL
    },
    getRefreshSecret(),
    { expiresIn: REFRESH_EXPIRES }
  );
}

function verifyAccessToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(String(token || ''), getAccessSecret());
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw createDropshipperError(401, 'TOKEN_EXPIRED', 'Token has expired');
    }
    throw createDropshipperError(401, 'INVALID_TOKEN', 'Invalid token');
  }
  if (decoded.type !== 'access') {
    throw createDropshipperError(401, 'INVALID_TOKEN_TYPE', 'Invalid token type');
  }
  if (String(decoded.portal || '') !== PORTAL) {
    throw createDropshipperError(401, 'INVALID_PORTAL', 'Not a dropshipper access token');
  }
  if (decoded.channel && String(decoded.channel) !== DROPSHIP_CHANNEL) {
    throw createDropshipperError(401, 'CHANNEL_MISMATCH', 'Invalid token channel');
  }
  if (!decoded.id) {
    throw createDropshipperError(401, 'INVALID_TOKEN', 'Token missing subject');
  }
  return decoded;
}

function verifyRefreshToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(String(token || ''), getRefreshSecret());
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw createDropshipperError(401, 'TOKEN_EXPIRED', 'Refresh token has expired');
    }
    throw createDropshipperError(401, 'INVALID_TOKEN', 'Invalid refresh token');
  }
  if (decoded.type !== 'refresh') {
    throw createDropshipperError(401, 'INVALID_TOKEN_TYPE', 'Invalid refresh token type');
  }
  if (String(decoded.portal || '') !== PORTAL) {
    throw createDropshipperError(401, 'INVALID_PORTAL', 'Not a dropshipper refresh token');
  }
  return decoded;
}

function extractBearerToken(req) {
  const authHeader = req.headers?.authorization;
  if (!authHeader) return null;
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : String(authHeader).trim();
}

module.exports = {
  PORTAL,
  ACCESS_EXPIRES,
  REFRESH_EXPIRES,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  extractBearerToken
};
