'use strict';

const activateService = require('../services/dropshipperActivate.service');
const { handleControllerError } = require('../utils/dropshipperHttp');
const logger = require('../../utils/logger');

exports.sendActivationOtp = async (req, res) => {
  try {
    const result = await activateService.sendActivationOtp({
      email: req.body?.email,
      phone: req.body?.phone,
      dropshipperId: req.body?.dropshipperId
    });
    return res.json(result);
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperActivate.sendOtp]');
  }
};

exports.completeActivation = async (req, res) => {
  try {
    const result = await activateService.completeActivation(req.body || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperActivate.complete]');
  }
};
