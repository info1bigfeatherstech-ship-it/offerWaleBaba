'use strict';

/**
 * Global dropshipper module settings (singleton).
 * NOT keyed by ecomm/wholesale storefront — this is dropship-channel config only.
 */

const mongoose = require('mongoose');
const {
  SETTINGS_DOC_KEY,
  DEFAULT_SUBSCRIPTION_AMOUNT_INR,
  SUBSCRIPTION_YEARS
} = require('../constants/dropshipperAuth');

const dropshipperSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: SETTINGS_DOC_KEY,
      immutable: true
    },

    /** Current fee for NEW registrations and renewals. */
    subscriptionAmountInr: {
      type: Number,
      required: true,
      min: 1,
      default: DEFAULT_SUBSCRIPTION_AMOUNT_INR
    },

    /**
     * Informational — duration is hardcoded in app logic for now.
     * Admin duration options come later; do not treat this as editable yet.
     */
    subscriptionYears: {
      type: Number,
      default: SUBSCRIPTION_YEARS,
      min: 1
    },

    registrationOpen: {
      type: Boolean,
      default: true
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },

    channel: { type: String, default: 'dropship', immutable: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DropshipperSettings', dropshipperSettingsSchema);
