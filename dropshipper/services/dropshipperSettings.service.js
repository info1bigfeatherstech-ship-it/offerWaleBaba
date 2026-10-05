'use strict';

/**
 * Dropshipper settings — singleton, channel=dropship only.
 * Never reads/writes ecomm or wholesale checkout settings.
 */

const DropshipperSettings = require('../models/DropshipperSettings');
const {
  SETTINGS_DOC_KEY,
  DEFAULT_SUBSCRIPTION_AMOUNT_INR,
  SUBSCRIPTION_YEARS,
  DROPSHIP_CHANNEL
} = require('../constants/dropshipperAuth');
const { parseSubscriptionAmountInr } = require('../utils/dropshipperValidators');
const { createDropshipperError } = require('../utils/dropshipperHttp');
const logger = require('../../utils/logger');

function toPublicSettings(doc) {
  return {
    channel: DROPSHIP_CHANNEL,
    subscriptionAmountInr:
      doc?.subscriptionAmountInr != null
        ? Number(doc.subscriptionAmountInr)
        : DEFAULT_SUBSCRIPTION_AMOUNT_INR,
    /** Hardcoded for now — exposed so FE can show "1 year plan". */
    subscriptionYears: SUBSCRIPTION_YEARS,
    registrationOpen: doc?.registrationOpen !== false,
    updatedAt: doc?.updatedAt || null
  };
}

function toAdminSettings(doc) {
  return {
    ...toPublicSettings(doc),
    key: doc?.key || SETTINGS_DOC_KEY,
    updatedBy: doc?.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc?.createdAt || null
  };
}

async function getOrCreateSettings() {
  let doc = await DropshipperSettings.findOne({ key: SETTINGS_DOC_KEY });
  if (doc) return doc;

  try {
    doc = await DropshipperSettings.create({
      key: SETTINGS_DOC_KEY,
      subscriptionAmountInr: DEFAULT_SUBSCRIPTION_AMOUNT_INR,
      subscriptionYears: SUBSCRIPTION_YEARS,
      registrationOpen: true,
      channel: DROPSHIP_CHANNEL
    });
    logger.info('[dropshipperSettings] Created default settings', {
      amountInr: DEFAULT_SUBSCRIPTION_AMOUNT_INR
    });
    return doc;
  } catch (err) {
    if (err?.code === 11000) {
      doc = await DropshipperSettings.findOne({ key: SETTINGS_DOC_KEY });
      if (doc) return doc;
    }
    throw createDropshipperError(
      500,
      'SETTINGS_INIT_FAILED',
      'Could not initialize dropshipper settings'
    );
  }
}

async function getPublicSettings() {
  const doc = await getOrCreateSettings();
  return toPublicSettings(doc);
}

async function getAdminSettings() {
  const doc = await getOrCreateSettings();
  return toAdminSettings(doc);
}

/**
 * @param {{ subscriptionAmountInr?: number, registrationOpen?: boolean }} patch
 * @param {string|null} adminUserId
 */
async function updateSettings(patch = {}, adminUserId = null) {
  const doc = await getOrCreateSettings();
  let dirty = false;

  if (Object.prototype.hasOwnProperty.call(patch, 'subscriptionAmountInr')) {
    doc.subscriptionAmountInr = parseSubscriptionAmountInr(patch.subscriptionAmountInr);
    dirty = true;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'registrationOpen')) {
    doc.registrationOpen = Boolean(patch.registrationOpen);
    dirty = true;
  }

  // subscriptionYears intentionally not editable in Phase A (hardcoded).

  if (!dirty) {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      'Provide subscriptionAmountInr and/or registrationOpen to update'
    );
  }

  if (adminUserId) {
    doc.updatedBy = adminUserId;
  }

  try {
    await doc.save();
  } catch (err) {
    logger.error('[dropshipperSettings] save failed', { message: err?.message });
    throw createDropshipperError(500, 'SETTINGS_SAVE_FAILED', 'Failed to save settings');
  }

  logger.info('[dropshipperSettings] Updated', {
    amountInr: doc.subscriptionAmountInr,
    registrationOpen: doc.registrationOpen,
    adminUserId: adminUserId ? String(adminUserId) : null
  });

  return toAdminSettings(doc);
}

/** Current payable fee for new registration / renew (live setting). */
async function getCurrentSubscriptionAmountInr() {
  const settings = await getPublicSettings();
  if (settings.registrationOpen === false) {
    throw createDropshipperError(
      403,
      'REGISTRATION_CLOSED',
      'Dropshipper registration is temporarily closed'
    );
  }
  return settings.subscriptionAmountInr;
}

module.exports = {
  getOrCreateSettings,
  getPublicSettings,
  getAdminSettings,
  updateSettings,
  getCurrentSubscriptionAmountInr,
  toPublicSettings,
  toAdminSettings
};
