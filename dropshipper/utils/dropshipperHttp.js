'use strict';

function createDropshipperError(statusCode, code, message, details = undefined) {
  const err = new Error(message || code || 'Dropshipper error');
  err.statusCode = statusCode || 500;
  err.code = code || 'DROPSHIPPER_ERROR';
  if (details !== undefined) err.details = details;
  return err;
}

function respondError(res, statusCode, code, message, details = undefined) {
  const body = { success: false, code, message };
  if (details !== undefined) body.details = details;
  return res.status(statusCode).json(body);
}

function handleControllerError(res, err, logger, logLabel = '[dropshipperAuth]') {
  const status = err?.statusCode || 500;
  const code = err?.code || 'DROPSHIPPER_ERROR';
  if (status >= 500 && logger) {
    logger.error(logLabel, {
      message: err?.message,
      code,
      stack: err?.stack
    });
  }
  return respondError(
    res,
    status,
    code,
    err?.message || 'Request failed',
    err?.details
  );
}

module.exports = {
  createDropshipperError,
  respondError,
  handleControllerError
};
