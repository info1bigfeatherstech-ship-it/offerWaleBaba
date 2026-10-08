/**
 * Same Day / Shiprocket Quick — opt-in overlay on top of standard shipping.
 *
 * Admin Settings (Delivery → Same Day Delivery) is the source of truth:
 * - enabled + pincodes (+ optional cutoff / warehouse lat-lng)
 * Env vars remain optional fallbacks only (warehouse coords / cutoff / method).
 *
 * Production safety:
 * - Default OFF in DB
 * - Per-storefront (ecomm/wholesale) — never mixes
 * - Soft-fail: probe errors never break standard Shiprocket/Shipmozo quotes
 * - One order = one provider: same_day stamps shiprocket; standard keeps active provider
 */

const logger = require('../utils/logger');
const ShiprocketService = require('../utils/shiprocket');
const shippingProviderSettingsService = require('./shippingProviderSettings.service');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');

const SHIPPING_SPEEDS = Object.freeze({
  STANDARD: 'standard',
  SAME_DAY: 'same_day'
});

function envFlagTrue(name) {
  return String(process.env[name] || '')
    .trim()
    .toLowerCase() === 'true';
}

function parseCsvSet(raw) {
  return new Set(
    String(raw || '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function normalizeShippingSpeed(value) {
  const s = String(value || '')
    .toLowerCase()
    .trim();
  if (s === SHIPPING_SPEEDS.SAME_DAY || s === 'sameday' || s === 'same-day' || s === 'quick') {
    return SHIPPING_SPEEDS.SAME_DAY;
  }
  return SHIPPING_SPEEDS.STANDARD;
}

/**
 * Legacy/env-only snapshot (no DB). Prefer getConfigForStorefront().
 */
function getConfig() {
  const storefronts = parseCsvSet(process.env.SAME_DAY_STOREFRONTS || 'ecomm');
  if (storefronts.size === 0) storefronts.add('ecomm');

  const pincodes = parseCsvSet(process.env.SAME_DAY_PINCODES || '');
  const cutoffHour = Number(process.env.SAME_DAY_CUTOFF_HOUR);
  const warehouseLat = Number(process.env.SAME_DAY_WAREHOUSE_LAT);
  const warehouseLng = Number(process.env.SAME_DAY_WAREHOUSE_LNG);

  return {
    enabled: envFlagTrue('SAME_DAY_DELIVERY_ENABLED'),
    storefront: 'ecomm',
    pincodes,
    cutoffHour: Number.isFinite(cutoffHour) ? cutoffHour : 14,
    timezone: String(process.env.SAME_DAY_TIMEZONE || 'Asia/Kolkata').trim() || 'Asia/Kolkata',
    warehouseLat: Number.isFinite(warehouseLat) ? warehouseLat : null,
    warehouseLng: Number.isFinite(warehouseLng) ? warehouseLng : null,
    checkoutShippingMethod: String(process.env.SAME_DAY_CHECKOUT_SHIPPING_METHOD || 'SR_QUICK')
      .trim()
      .toUpperCase() || 'SR_QUICK',
    source: 'env'
  };
}

/**
 * Admin DB settings for storefront, with env fallbacks for coords/cutoff/method.
 */
async function getConfigForStorefront(storefront = 'ecomm') {
  const sf = shippingProviderSettingsService.normalizeStorefront(storefront);
  const envCfg = getConfig();

  try {
    const runtime = await shippingProviderSettingsService.getRuntimeConfig(sf);
    const sd = runtime.sameDay || {};
    const pinSet = new Set(
      Array.isArray(sd.pincodes)
        ? sd.pincodes.map((p) => String(p).replace(/\D/g, '').slice(0, 6)).filter((p) => p.length === 6)
        : []
    );

    const cutoff =
      sd.cutoffHour != null && Number.isFinite(Number(sd.cutoffHour))
        ? Number(sd.cutoffHour)
        : envCfg.cutoffHour;
    const warehouseLat =
      sd.warehouseLat != null && Number.isFinite(Number(sd.warehouseLat))
        ? Number(sd.warehouseLat)
        : envCfg.warehouseLat;
    const warehouseLng =
      sd.warehouseLng != null && Number.isFinite(Number(sd.warehouseLng))
        ? Number(sd.warehouseLng)
        : envCfg.warehouseLng;

    return {
      enabled: Boolean(sd.enabled),
      storefront: sf,
      pincodes: pinSet,
      cutoffHour: Number.isFinite(cutoff) ? cutoff : 14,
      timezone: envCfg.timezone,
      warehouseLat,
      warehouseLng,
      checkoutShippingMethod: envCfg.checkoutShippingMethod,
      source: 'db'
    };
  } catch (err) {
    logger.warn('[sameDayDelivery] DB config load failed — using env fallback', {
      message: err?.message,
      storefront: sf
    });
    return { ...envCfg, storefront: sf, source: 'env_fallback' };
  }
}

async function isEnabledForStorefront(storefront) {
  const cfg = await getConfigForStorefront(storefront);
  return Boolean(cfg.enabled);
}

/**
 * Current local hour in configured timezone (0–23). Soft-fail → treat as past cutoff.
 */
function getLocalHourNow(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isFinite(hour) ? hour : null;
  } catch (_) {
    return null;
  }
}

function isWithinCutoff(cfg) {
  const hour = getLocalHourNow(cfg?.timezone || 'Asia/Kolkata');
  if (hour == null) return false;
  const cutoff = Number(cfg?.cutoffHour);
  return hour < (Number.isFinite(cutoff) ? cutoff : 14);
}

function isPincodeAllowed(pincode, cfg) {
  const pin = String(pincode || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  if (pin.length !== 6) return false;
  // Admin-enabled mode requires explicit allowlist (empty = not offered).
  if (!cfg?.pincodes || cfg.pincodes.size === 0) return false;
  return cfg.pincodes.has(pin);
}

function emptySameDayOption(reason, extra = {}) {
  return {
    available: false,
    shippingSpeed: SHIPPING_SPEEDS.SAME_DAY,
    reason: reason || 'unavailable',
    deliveryCharges: 0,
    freightInr: 0,
    codFeeInr: 0,
    estimatedDays: null,
    etaLabel: null,
    courierName: null,
    courierCompanyId: null,
    shippingProvider: SHIPPING_PROVIDERS.SHIPROCKET,
    codAvailable: false,
    checkoutShippingMethod: null,
    cutoffHour: Number.isFinite(Number(extra.cutoffHour))
      ? Number(extra.cutoffHour)
      : 14,
    ...extra
  };
}

/**
 * Soft probe — never throws to caller. Standard checkout must remain unaffected.
 */
async function probeSameDayOption({
  deliveryPincode,
  storefront = 'ecomm',
  weightKg,
  lengthCm,
  widthCm,
  heightCm,
  codAmount = 0,
  deliveryLat = null,
  deliveryLng = null
} = {}) {
  let cfg;
  try {
    cfg = await getConfigForStorefront(storefront);
  } catch (_) {
    return emptySameDayOption('config_error');
  }

  try {
    if (!cfg.enabled) {
      return emptySameDayOption('disabled_for_storefront', { cutoffHour: cfg.cutoffHour });
    }
    if (!cfg.pincodes.size) {
      return emptySameDayOption('no_pincodes_configured', { cutoffHour: cfg.cutoffHour });
    }
    if (!isWithinCutoff(cfg)) {
      return emptySameDayOption('past_cutoff', { cutoffHour: cfg.cutoffHour });
    }
    if (!isPincodeAllowed(deliveryPincode, cfg)) {
      return emptySameDayOption('pincode_not_allowed', { cutoffHour: cfg.cutoffHour });
    }

    const result = await ShiprocketService.checkSameDayServiceability(deliveryPincode, {
      weightKg,
      lengthCm,
      widthCm,
      heightCm,
      codAmount,
      deliveryLat,
      deliveryLng,
      warehouseLat: cfg.warehouseLat,
      warehouseLng: cfg.warehouseLng
    });

    if (!result?.available) {
      return emptySameDayOption(result?.reason || 'not_serviceable', {
        message: result?.message || null,
        cutoffHour: cfg.cutoffHour
      });
    }

    return {
      available: true,
      shippingSpeed: SHIPPING_SPEEDS.SAME_DAY,
      reason: null,
      deliveryCharges: Number(result.deliveryCharges) || 0,
      freightInr: Number(result.freightInr) || Number(result.deliveryCharges) || 0,
      codFeeInr: Number(result.codFeeInr) || 0,
      estimatedDays: result.estimatedDays != null ? String(result.estimatedDays) : '0',
      etaLabel: result.etaLabel || 'Same day delivery',
      courierName: result.courierName || null,
      courierCompanyId: result.courierCompanyId ?? null,
      shippingProvider: SHIPPING_PROVIDERS.SHIPROCKET,
      codAvailable: result.codAvailable !== false,
      checkoutShippingMethod: cfg.checkoutShippingMethod,
      cutoffHour: cfg.cutoffHour,
      mock: Boolean(result.mock)
    };
  } catch (err) {
    logger.warn('[sameDayDelivery] probe soft-failed', {
      message: err?.message,
      storefront,
      deliveryPincode
    });
    return emptySameDayOption('probe_error', { cutoffHour: cfg?.cutoffHour });
  }
}

/**
 * Build deliveryMeta override used by computeCheckoutTotals when user picks same_day.
 */
function toDeliveryMetaOverride(sameDayOption) {
  if (!sameDayOption?.available) return null;
  return {
    estimatedDays: sameDayOption.estimatedDays,
    courierName: sameDayOption.courierName,
    courierCompanyId: sameDayOption.courierCompanyId,
    shipmozoCourierId: null,
    shippingProvider: SHIPPING_PROVIDERS.SHIPROCKET,
    pickupsAutomaticallyScheduled: null,
    isDeliverable: true,
    codAvailable: sameDayOption.codAvailable !== false,
    mock: Boolean(sameDayOption.mock),
    freightInr: sameDayOption.freightInr,
    codFeeInr: sameDayOption.codFeeInr,
    shippingSpeed: SHIPPING_SPEEDS.SAME_DAY,
    checkoutShippingMethod: sameDayOption.checkoutShippingMethod,
    etaLabel: sameDayOption.etaLabel
  };
}

function isSameDayOrder(order) {
  return normalizeShippingSpeed(order?.shippingSpeed || order?.shippingSnapshot?.shippingSpeed) ===
    SHIPPING_SPEEDS.SAME_DAY;
}

/** Mongo filter for admin lists — keeps standard and same-day orders separated. */
function buildShippingSpeedScopeMatch(scope) {
  const s = String(scope || 'standard')
    .toLowerCase()
    .trim();
  if (s === 'same_day' || s === 'sameday' || s === 'same-day') {
    return { shippingSpeed: SHIPPING_SPEEDS.SAME_DAY };
  }
  if (s === 'all') {
    return {};
  }
  return {
    $or: [
      { shippingSpeed: { $exists: false } },
      { shippingSpeed: null },
      { shippingSpeed: SHIPPING_SPEEDS.STANDARD }
    ]
  };
}

module.exports = {
  SHIPPING_SPEEDS,
  getConfig,
  getConfigForStorefront,
  isEnabledForStorefront,
  isWithinCutoff,
  isPincodeAllowed,
  normalizeShippingSpeed,
  emptySameDayOption,
  probeSameDayOption,
  toDeliveryMetaOverride,
  isSameDayOrder,
  buildShippingSpeedScopeMatch
};
