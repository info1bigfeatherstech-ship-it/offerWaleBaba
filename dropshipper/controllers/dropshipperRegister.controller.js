'use strict';

const registerService = require('../services/dropshipperRegister.service');
const { handleControllerError } = require('../utils/dropshipperHttp');
const logger = require('../../utils/logger');

exports.startRegistration = async (req, res) => {
  try {
    const preview = await registerService.startRegistration(req.body || {});
    return res.json({ success: true, ...preview });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperRegister.start]');
  }
};

exports.createRegistrationPayment = async (req, res) => {
  try {
    const result = await registerService.createRegistrationPayment(req.body || {});
    return res.status(201).json({
      success: true,
      message: 'Complete Razorpay payment for subscription fee',
      ...result
    });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperRegister.createPayment]');
  }
};

exports.verifyRegistrationPayment = async (req, res) => {
  try {
    const result = await registerService.verifyRegistrationPayment(req.body || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperRegister.verifyPayment]');
  }
};

exports.getRegistrationStatus = async (req, res) => {
  try {
    const result = await registerService.getRegistrationStatus({
      requestId: req.params.requestId,
      email: req.query.email,
      phone: req.query.phone
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleControllerError(res, err, logger, '[dropshipperRegister.status]');
  }
};
