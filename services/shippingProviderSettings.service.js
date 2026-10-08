const ShippingProviderSettings = require('../models/ShippingProviderSettings');
const {
  SHIPPING_PROVIDERS,
  DEFAULT_SHIPPING_PROVIDER,
  normalizeShippingProvider
} = require('../constants/shippingProviders');
const logger = require('../utils/logger');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale']);
const LEGACY_SINGLETON_KEY = 'default';

function normalizeStorefront(value) {
  const s = String(value || 'ecomm').toLowerCase().trim();
  return VALID_STOREFRONTS.has(s) ? s : 'ecomm';
}

function cloneShipmozo(src) {
  return {
    enabled: src?.enabled !== false,
    publicKey: null,
    privateKey: null,
    warehouseId: src?.warehouseId || String(process.env.SHIPMOZO_WAREHOUSE_ID || '').trim() || null,
    pickupPincode:
      String(src?.pickupPincode || process.env.SHIPMOZO_PICKUP_PINCODE || '')
        .replace(/\D/g, '')
        .slice(0, 6) || null,
    warehouseAddressTitle: src?.warehouseAddressTitle || null
  };
}

function normalizeSameDayPincodes(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/[,;\s\n\r]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const pin = String(item || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (pin.length !== 6 || seen.has(pin)) continue;
    seen.add(pin);
    out.push(pin);
  }
  return out;
}

function cloneSameDay(src) {
  const cutoff = Number(src?.cutoffHour);
  const lat = Number(src?.warehouseLat);
  const lng = Number(src?.warehouseLng);
  return {
    enabled: Boolean(src?.enabled),
    pincodes: normalizeSameDayPincodes(src?.pincodes),
    cutoffHour: Number.isFinite(cutoff) ? Math.min(23, Math.max(0, Math.floor(cutoff))) : 14,
    warehouseLat: Number.isFinite(lat) ? lat : null,
    warehouseLng: Number.isFinite(lng) ? lng : null
  };
}

function toSameDayPublic(doc) {
  const sd = cloneSameDay(doc?.sameDay);
  return {
    enabled: sd.enabled,
    pincodes: sd.pincodes,
    pincodeCount: sd.pincodes.length,
    cutoffHour: sd.cutoffHour,
    warehouseLat: sd.warehouseLat,
    warehouseLng: sd.warehouseLng,
    ready: Boolean(sd.enabled && sd.pincodes.length > 0)
  };
}

/**
 * API keys are env-only (never accepted from admin panel / DB write path).
 * Operational fields (warehouse, pickup pin, active provider) stay in settings.
 */
function resolveShipmozoKeysFromEnv() {
  const publicKey = String(process.env.SHIPMOZO_PUBLIC_KEY || '').trim() || null;
  const privateKey = String(process.env.SHIPMOZO_PRIVATE_KEY || '').trim() || null;
  return {
    publicKey,
    privateKey,
    keysConfigured: Boolean(publicKey && privateKey),
    publicKeyConfigured: Boolean(publicKey),
    privateKeyConfigured: Boolean(privateKey)
  };
}

function resolveShipmozoPickupPincode(doc) {
  const fromDoc = String(doc?.shipmozo?.pickupPincode || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  const fromEnv = String(process.env.SHIPMOZO_PICKUP_PINCODE || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  return fromDoc.length === 6 ? fromDoc : fromEnv.length === 6 ? fromEnv : null;
}

function resolveShipmozoWarehouseId(doc) {
  const fromDoc = String(doc?.shipmozo?.warehouseId || '').trim();
  const fromEnv = String(process.env.SHIPMOZO_WAREHOUSE_ID || '').trim();
  return fromDoc || fromEnv || null;
}

/**
 * Admin/public config shape — never exposes key values.
 */
function toPublicConfig(doc) {
  const keys = resolveShipmozoKeysFromEnv();
  const active =
    normalizeShippingProvider(doc?.activeProvider) || DEFAULT_SHIPPING_PROVIDER;
  const pickup = resolveShipmozoPickupPincode(doc);
  const warehouseId = resolveShipmozoWarehouseId(doc);
  const shipmozoEnabled = doc?.shipmozo?.enabled !== false;
  const shipmozoReady = Boolean(
    shipmozoEnabled && keys.keysConfigured && warehouseId && pickup
  );

  return {
    activeProvider: active,
    shiprocket: {
      note: 'Configured via SHIPROCKET_* and STORE_PINCODE / PICKUP_PINCODE env (unchanged).',
      enabled: String(process.env.SHIPROCKET_ENABLED || '').toLowerCase() === 'true'
    },
    shipmozo: {
      enabled: shipmozoEnabled,
      ready: shipmozoReady,
      /** Keys live only in server env — panel cannot set/read them */
      keysSource: 'env',
      keysConfigured: keys.keysConfigured,
      hasPublicKey: keys.publicKeyConfigured,
      hasPrivateKey: keys.privateKeyConfigured,
      warehouseId: warehouseId || null,
      pickupPincode: pickup || null,
      warehouseAddressTitle: doc?.shipmozo?.warehouseAddressTitle || null,
      missing: [
        !keys.publicKeyConfigured ? 'SHIPMOZO_PUBLIC_KEY (env)' : null,
        !keys.privateKeyConfigured ? 'SHIPMOZO_PRIVATE_KEY (env)' : null,
        !warehouseId ? 'warehouseId' : null,
        !pickup ? 'pickupPincode' : null
      ].filter(Boolean)
    },
    sameDay: toSameDayPublic(doc),
    updatedAt: doc?.updatedAt || null
  };
}

/**
 * Internal runtime config with real secrets (never send to client).
 */
function toRuntimeConfig(doc) {
  const keys = resolveShipmozoKeysFromEnv();
  const active =
    normalizeShippingProvider(doc?.activeProvider) || DEFAULT_SHIPPING_PROVIDER;
  return {
    activeProvider: active,
    shipmozo: {
      enabled: doc?.shipmozo?.enabled !== false,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      warehouseId: resolveShipmozoWarehouseId(doc),
      pickupPincode: resolveShipmozoPickupPincode(doc),
      warehouseAddressTitle: doc?.shipmozo?.warehouseAddressTitle || null
    },
    sameDay: cloneSameDay(doc?.sameDay)
  };
}

async function getOrCreateSettings(storefront) {
  const sf = normalizeStorefront(storefront);
  let doc = await ShippingProviderSettings.findOne({ storefront: sf });
  if (doc) return doc;

  const legacy = await ShippingProviderSettings.findOne({
    $or: [{ key: LEGACY_SINGLETON_KEY }, { storefront: { $exists: false } }, { storefront: null }]
  }).sort({ updatedAt: -1 });

  if (sf === 'ecomm' && legacy && !legacy.storefront) {
    try {
      legacy.storefront = 'ecomm';
      legacy.key = null;
      await legacy.save();
      logger.info('[shippingProviderSettings] Migrated legacy singleton to storefront=ecomm');
      return legacy;
    } catch (err) {
      if (err?.code === 11000) {
        return ShippingProviderSettings.findOne({ storefront: 'ecomm' });
      }
      throw err;
    }
  }

  const template = (await ShippingProviderSettings.findOne({ storefront: 'ecomm' })) || legacy;
  const seed = {
    storefront: sf,
    activeProvider: normalizeShippingProvider(template?.activeProvider) || DEFAULT_SHIPPING_PROVIDER,
    shipmozo: cloneShipmozo(template?.shipmozo),
    sameDay: cloneSameDay(template?.sameDay)
  };

  try {
    doc = await ShippingProviderSettings.create(seed);
    logger.info('[shippingProviderSettings] Created storefront settings', {
      storefront: sf,
      clonedFrom: template?.storefront || 'legacy-or-defaults'
    });
    return doc;
  } catch (err) {
    if (err?.code === 11000) {
      return ShippingProviderSettings.findOne({ storefront: sf });
    }
    throw err;
  }
}

async function getPublicConfig(storefront) {
  const doc = await getOrCreateSettings(storefront);
  const config = toPublicConfig(doc);
  config.storefront = normalizeStorefront(storefront);
  return config;
}

async function getRuntimeConfig(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return toRuntimeConfig(doc);
}

/**
 * Provider used for NEW checkout / place-order. Falls back to shiprocket if
 * shipmozo is active but not ready (keys/warehouse/pin missing).
 */
async function getActiveProviderForNewOrders(storefront) {
  const runtime = await getRuntimeConfig(storefront);
  if (runtime.activeProvider === SHIPPING_PROVIDERS.SHIPMOZO) {
    const sm = runtime.shipmozo;
    if (
      sm.enabled &&
      sm.publicKey &&
      sm.privateKey &&
      sm.warehouseId &&
      sm.pickupPincode
    ) {
      return SHIPPING_PROVIDERS.SHIPMOZO;
    }
    logger.warn(
      '[shippingProviderSettings] activeProvider=shipmozo but config incomplete — falling back to shiprocket for new orders',
      {
        hasPublicKey: Boolean(sm.publicKey),
        hasPrivateKey: Boolean(sm.privateKey),
        hasWarehouseId: Boolean(sm.warehouseId),
        hasPickupPincode: Boolean(sm.pickupPincode)
      }
    );
    return SHIPPING_PROVIDERS.SHIPROCKET;
  }
  return SHIPPING_PROVIDERS.SHIPROCKET;
}

/**
 * @param {object} body
 * @param {string|null} updatedByUserId
 * @param {string} storefront
 */
async function applyAdminPatch(body, updatedByUserId, storefront) {
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['Request body is required'] };
  }

  const errors = [];
  const hasActive = body.activeProvider !== undefined;
  const hasShipmozo = body.shipmozo !== undefined && body.shipmozo !== null;
  const hasSameDay = body.sameDay !== undefined && body.sameDay !== null;

  if (!hasActive && !hasShipmozo && !hasSameDay) {
    return {
      ok: false,
      errors: ['Provide activeProvider, shipmozo, and/or sameDay config fields']
    };
  }

  // Reject any attempt to set API keys via panel/API
  if (
    hasShipmozo &&
    typeof body.shipmozo === 'object' &&
    (body.shipmozo.publicKey !== undefined || body.shipmozo.privateKey !== undefined)
  ) {
    return {
      ok: false,
      errors: [
        'Shipmozo publicKey/privateKey cannot be set from the panel. Configure SHIPMOZO_PUBLIC_KEY and SHIPMOZO_PRIVATE_KEY in server env only.'
      ]
    };
  }

  let nextActive = null;
  if (hasActive) {
    nextActive = normalizeShippingProvider(body.activeProvider);
    if (!nextActive) {
      errors.push('activeProvider must be "shiprocket" or "shipmozo"');
    }
  }

  const smPatch = hasShipmozo && typeof body.shipmozo === 'object' ? body.shipmozo : null;
  if (hasShipmozo && !smPatch) {
    errors.push('shipmozo must be an object when provided');
  }

  if (smPatch) {
    if (smPatch.enabled !== undefined && typeof smPatch.enabled !== 'boolean') {
      errors.push('shipmozo.enabled must be a boolean');
    }
    if (smPatch.pickupPincode != null && String(smPatch.pickupPincode).trim() !== '') {
      const pin = String(smPatch.pickupPincode).replace(/\D/g, '').slice(0, 6);
      if (pin.length !== 6) {
        errors.push('shipmozo.pickupPincode must be a 6-digit pincode');
      }
    }
  }

  const sdPatch = hasSameDay && typeof body.sameDay === 'object' ? body.sameDay : null;
  if (hasSameDay && !sdPatch) {
    errors.push('sameDay must be an object when provided');
  }
  if (sdPatch) {
    if (sdPatch.enabled !== undefined && typeof sdPatch.enabled !== 'boolean') {
      errors.push('sameDay.enabled must be a boolean');
    }
    if (sdPatch.cutoffHour !== undefined && sdPatch.cutoffHour !== null && sdPatch.cutoffHour !== '') {
      const h = Number(sdPatch.cutoffHour);
      if (!Number.isFinite(h) || h < 0 || h > 23) {
        errors.push('sameDay.cutoffHour must be between 0 and 23');
      }
    }
    if (sdPatch.warehouseLat !== undefined && sdPatch.warehouseLat !== null && sdPatch.warehouseLat !== '') {
      const lat = Number(sdPatch.warehouseLat);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        errors.push('sameDay.warehouseLat must be a valid latitude');
      }
    }
    if (sdPatch.warehouseLng !== undefined && sdPatch.warehouseLng !== null && sdPatch.warehouseLng !== '') {
      const lng = Number(sdPatch.warehouseLng);
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        errors.push('sameDay.warehouseLng must be a valid longitude');
      }
    }
    if (sdPatch.pincodes !== undefined) {
      sdPatch._normalizedPincodes = normalizeSameDayPincodes(sdPatch.pincodes);
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  const current = await getOrCreateSettings(storefront);
  const $set = {
    updatedBy: updatedByUserId || null
  };

  if (nextActive) {
    $set.activeProvider = nextActive;
  }

  if (smPatch) {
    if (smPatch.enabled !== undefined) {
      $set['shipmozo.enabled'] = Boolean(smPatch.enabled);
    }
    // Never persist keys from API — clear any legacy DB keys so env is sole source
    $set['shipmozo.publicKey'] = null;
    $set['shipmozo.privateKey'] = null;

    if (smPatch.warehouseId !== undefined) {
      const v = String(smPatch.warehouseId || '').trim();
      $set['shipmozo.warehouseId'] = v || null;
    }
    if (smPatch.pickupPincode !== undefined) {
      const pin = String(smPatch.pickupPincode || '')
        .replace(/\D/g, '')
        .slice(0, 6);
      $set['shipmozo.pickupPincode'] = pin.length === 6 ? pin : null;
    }
    if (smPatch.warehouseAddressTitle !== undefined) {
      const v = String(smPatch.warehouseAddressTitle || '').trim();
      $set['shipmozo.warehouseAddressTitle'] = v || null;
    }
  }

  if (sdPatch) {
    if (sdPatch.enabled !== undefined) {
      $set['sameDay.enabled'] = Boolean(sdPatch.enabled);
    }
    if (sdPatch.pincodes !== undefined) {
      $set['sameDay.pincodes'] = sdPatch._normalizedPincodes || [];
    }
    if (sdPatch.cutoffHour !== undefined && sdPatch.cutoffHour !== null && sdPatch.cutoffHour !== '') {
      $set['sameDay.cutoffHour'] = Math.min(23, Math.max(0, Math.floor(Number(sdPatch.cutoffHour))));
    }
    if (sdPatch.warehouseLat !== undefined) {
      if (sdPatch.warehouseLat === null || sdPatch.warehouseLat === '') {
        $set['sameDay.warehouseLat'] = null;
      } else {
        $set['sameDay.warehouseLat'] = Number(sdPatch.warehouseLat);
      }
    }
    if (sdPatch.warehouseLng !== undefined) {
      if (sdPatch.warehouseLng === null || sdPatch.warehouseLng === '') {
        $set['sameDay.warehouseLng'] = null;
      } else {
        $set['sameDay.warehouseLng'] = Number(sdPatch.warehouseLng);
      }
    }

    const mergedEnabled =
      $set['sameDay.enabled'] !== undefined
        ? $set['sameDay.enabled']
        : Boolean(current.sameDay?.enabled);
    const mergedPins =
      $set['sameDay.pincodes'] !== undefined
        ? $set['sameDay.pincodes']
        : normalizeSameDayPincodes(current.sameDay?.pincodes);
    if (mergedEnabled && (!Array.isArray(mergedPins) || mergedPins.length === 0)) {
      return {
        ok: false,
        errors: [
          'Add at least one 6-digit pincode before enabling Same Day Delivery (near-warehouse serviceable pins).'
        ]
      };
    }
  }

  // If activating shipmozo, require ready config after merge
  const previewActive = nextActive || normalizeShippingProvider(current.activeProvider);
  if (previewActive === SHIPPING_PROVIDERS.SHIPMOZO) {
    const mergedForCheck = {
      shipmozo: {
        enabled:
          $set['shipmozo.enabled'] !== undefined
            ? $set['shipmozo.enabled']
            : current.shipmozo?.enabled !== false,
        warehouseId:
          $set['shipmozo.warehouseId'] !== undefined
            ? $set['shipmozo.warehouseId']
            : current.shipmozo?.warehouseId,
        pickupPincode:
          $set['shipmozo.pickupPincode'] !== undefined
            ? $set['shipmozo.pickupPincode']
            : current.shipmozo?.pickupPincode
      }
    };
    const keys = resolveShipmozoKeysFromEnv();
    const warehouseId = resolveShipmozoWarehouseId(mergedForCheck);
    const pickup = resolveShipmozoPickupPincode(mergedForCheck);
    const enabled = mergedForCheck.shipmozo.enabled !== false;
    if (!enabled) {
      return {
        ok: false,
        errors: ['Cannot set activeProvider to shipmozo while shipmozo.enabled is false']
      };
    }
    if (!keys.keysConfigured || !warehouseId || !pickup) {
      return {
        ok: false,
        errors: [
          'Cannot activate shipmozo until SHIPMOZO_PUBLIC_KEY + SHIPMOZO_PRIVATE_KEY are set in env, and warehouseId + pickupPincode are configured in settings'
        ],
        missing: [
          !keys.publicKeyConfigured ? 'SHIPMOZO_PUBLIC_KEY (env)' : null,
          !keys.privateKeyConfigured ? 'SHIPMOZO_PRIVATE_KEY (env)' : null,
          !warehouseId ? 'warehouseId' : null,
          !pickup ? 'pickupPincode' : null
        ].filter(Boolean)
      };
    }
  }

  const doc = await ShippingProviderSettings.findOneAndUpdate(
    { storefront: normalizeStorefront(storefront) },
    { $set },
    { new: true, runValidators: true }
  );

  if (!doc) {
    const err = new Error('Shipping provider settings not found after update');
    err.statusCode = 500;
    err.code = 'SHIPPING_PROVIDER_SETTINGS_UPDATE_FAILED';
    throw err;
  }

  logger.info('[shippingProviderSettings] Updated', {
    storefront: normalizeStorefront(storefront),
    activeProvider: doc.activeProvider,
    updatedBy: updatedByUserId || null
  });

  return { ok: true, config: { ...toPublicConfig(doc), storefront: normalizeStorefront(storefront) } };
}

async function ensurePerStorefrontIndexes(mongooseConnection) {
  const db = mongooseConnection?.connection?.db;
  if (!db) return;
  const col = db.collection('shippingprovidersettings');
  let indexes = [];
  try {
    indexes = await col.indexes();
  } catch (_) {
    return;
  }
  for (const idx of indexes) {
    const keys = Object.keys(idx.key || {});
    if (idx.unique && keys.length === 1 && keys[0] === 'key') {
      try {
        await col.dropIndex(idx.name);
        logger.info('[shippingProviderSettings] dropped legacy unique key index', { name: idx.name });
      } catch (err) {
        logger.warn('[shippingProviderSettings] could not drop key index', { message: err?.message });
      }
    }
  }
}

module.exports = {
  getOrCreateSettings,
  getPublicConfig,
  getRuntimeConfig,
  getActiveProviderForNewOrders,
  applyAdminPatch,
  toPublicConfig,
  toRuntimeConfig,
  cloneSameDay,
  normalizeSameDayPincodes,
  resolveShipmozoKeys: resolveShipmozoKeysFromEnv,
  resolveShipmozoKeysFromEnv,
  resolveShipmozoPickupPincode,
  resolveShipmozoWarehouseId,
  normalizeStorefront,
  ensurePerStorefrontIndexes
};
