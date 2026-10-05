'use strict';

const loginService = require('../services/dropshipperLogin.service');
const { handleControllerError, respondError } = require('../utils/dropshipperHttp');
const { blacklistToken } = require('../middlewares/dropshipperAccess.middleware');
const { extractBearerToken } = require('../utils/dropshipperJwt');
const logger = require('../../utils/logger');

exports.login = async (req, res) => {
  try {
    const result = await loginService.login({
      email: req.body?.email,
      phone: req.body?.phone,
      password: req.body?.password
    });
    return res.json({ success: true, message: 'Login successful', ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperLogin.login]');
  }
};

exports.refresh = async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken || req.body?.refresh_token;
    if (!refreshToken) {
      return respondError(res, 400, 'VALIDATION_ERROR', 'refreshToken is required');
    }
    const result = await loginService.refreshSession(refreshToken);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperLogin.refresh]');
  }
};

exports.me = async (req, res) => {
  try {
    const id = req.dropshipperId;
    if (!id) {
      return respondError(res, 401, 'UNAUTHORIZED', 'Login required');
    }
    const result = await loginService.getMe(id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperLogin.me]');
  }
};

exports.logout = async (req, res) => {
  try {
    const token = req.dropshipperToken || extractBearerToken(req);
    if (token) {
      await blacklistToken(token, 7 * 24 * 3600);
    }
    return res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperLogin.logout]');
  }
};
