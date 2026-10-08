const mongoose = require('mongoose');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');

/**
 * Per-storefront shipping-partner settings.
 * activeProvider applies only to NEW checkout / place-order on that storefront.
 * Existing orders keep order.shippingProvider forever.
 */
const shippingProviderSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      unique: true,
      index: true
    },
    /** @deprecated singleton leftover — no longer unique */
    key: {
      type: String,
      default: null,
      trim: true
    },
    activeProvider: {
      type: String,
      enum: Object.values(SHIPPING_PROVIDERS),
      default: SHIPPING_PROVIDERS.SHIPROCKET,
      required: true
    },
    shipmozo: {
      enabled: { type: Boolean, default: true },
      publicKey: { type: String, default: null, trim: true },
      privateKey: { type: String, default: null, trim: true },
      warehouseId: { type: String, default: null, trim: true },
      pickupPincode: { type: String, default: null, trim: true },
      warehouseAddressTitle: { type: String, default: null, trim: true }
    },
    /**
     * Same Day / Shiprocket Quick overlay (admin-controlled).
     * Does not change activeProvider — only offers same_day when enabled + pincode match.
     */
    sameDay: {
      enabled: { type: Boolean, default: false },
      /** Explicit allowlist — when enabled, at least one pincode is required for offers */
      pincodes: { type: [String], default: [] },
      cutoffHour: { type: Number, default: 14, min: 0, max: 23 },
      warehouseLat: { type: Number, default: null },
      warehouseLng: { type: Number, default: null }
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShippingProviderSettings', shippingProviderSettingsSchema);
