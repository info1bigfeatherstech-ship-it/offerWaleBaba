'use strict';

const settingsService = require('../services/dropshipperSettings.service');
const accountService = require('../services/dropshipperAccount.service');
const requestService = require('../services/dropshipperRequest.service');
const { handleControllerError, respondError } = require('../utils/dropshipperHttp');
const logger = require('../../utils/logger');

exports.getPublicSubscriptionSettings = async (req, res) => {
  try {
    const settings = await settingsService.getPublicSettings();
    return res.json({ success: true, settings });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.publicSettings]');
  }
};

exports.getAdminSettings = async (req, res) => {
  try {
    const settings = await settingsService.getAdminSettings();
    return res.json({ success: true, settings });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.adminSettings]');
  }
};

exports.updateAdminSettings = async (req, res) => {
  try {
    const settings = await settingsService.updateSettings(req.body || {}, req.userId || null);
    return res.json({
      success: true,
      message: 'Dropshipper settings updated',
      settings
    });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.updateSettings]');
  }
};

exports.listAccounts = async (req, res) => {
  try {
    const result = await accountService.listDropshippers({
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      q: req.query.q || req.query.search
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.listAccounts]');
  }
};

exports.getAccount = async (req, res) => {
  try {
    const dropshipper = await accountService.getDropshipperById(req.params.id);
    return res.json({ success: true, dropshipper });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.getAccount]');
  }
};

exports.listRequests = async (req, res) => {
  try {
    const result = await requestService.listRequests({
      page: req.query.page,
      limit: req.query.limit,
      adminStatus: req.query.adminStatus || req.query.status,
      kind: req.query.kind,
      q: req.query.q || req.query.search
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.listRequests]');
  }
};

exports.getRequest = async (req, res) => {
  try {
    const request = await requestService.getRequestById(req.params.id);
    return res.json({ success: true, request });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.getRequest]');
  }
};

exports.approveRequest = async (req, res) => {
  try {
    if (!req.userId) {
      return respondError(res, 401, 'UNAUTHORIZED', 'Admin authentication required');
    }
    const result = await requestService.approveRequest(req.params.id, req.userId, {
      note: req.body?.note || req.body?.decisionNote
    });
    return res.json({
      success: true,
      message: result.alreadyProcessed
        ? 'Request was already approved'
        : 'Request approved. Dropshipper must complete OTP + password next.',
      ...result
    });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.approveRequest]');
  }
};

exports.rejectRequest = async (req, res) => {
  try {
    if (!req.userId) {
      return respondError(res, 401, 'UNAUTHORIZED', 'Admin authentication required');
    }
    const result = await requestService.rejectRequest(req.params.id, req.userId, {
      note: req.body?.note || req.body?.decisionNote || req.body?.reason
    });
    return res.json({
      success: true,
      message: result.alreadyProcessed ? 'Request was already rejected' : 'Request rejected',
      ...result
    });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperAuth.rejectRequest]');
  }
};
