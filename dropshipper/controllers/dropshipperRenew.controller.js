'use strict';

const renewService = require('../services/dropshipperRenew.service');
const { handleControllerError, respondError } = require('../utils/dropshipperHttp');
const logger = require('../../utils/logger');

exports.getRenewQuote = async (req, res) => {
  try {
    const id = req.dropshipperId;
    if (!id) return respondError(res, 401, 'UNAUTHORIZED', 'Login required');
    const result = await renewService.getRenewQuote(id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperRenew.quote]');
  }
};

exports.createRenewPayment = async (req, res) => {
  try {
    const id = req.dropshipperId;
    if (!id) return respondError(res, 401, 'UNAUTHORIZED', 'Login required');
    const result = await renewService.createRenewPayment(id);
    return res.status(201).json({
      success: true,
      message: 'Complete Razorpay payment to renew subscription',
      ...result
    });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperRenew.createPayment]');
  }
};

exports.verifyRenewPayment = async (req, res) => {
  try {
    const id = req.dropshipperId;
    if (!id) return respondError(res, 401, 'UNAUTHORIZED', 'Login required');
    const result = await renewService.verifyRenewPayment(id, req.body || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperRenew.verifyPayment]');
  }
};
