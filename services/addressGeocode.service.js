/**
 * Nominatim (OSM) geocode for Same Day Delivery only.
 *
 * Safety:
 * - Only runs when Same Day is enabled AND pincode is on the admin allowlist
 * - Soft-fail: never throws to callers; address save/checkout must not break
 * - In-memory query cache + min interval (~1 req/sec) for public Nominatim etiquette
 * - Persists lat/lng + geocodeKey on Address so the same address is not re-hit
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const sameDayDeliveryService = require('./sameDayDelivery.service');

const NOMINATIM_URL = String(
  process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org/search'
).replace(/\/+$/, '');
const USER_AGENT =
  String(process.env.NOMINATIM_USER_AGENT || '').trim() ||
  'OfferWaleBaba/1.0 (same-day-geocode; contact: support@offerwalebaba.com)';
const MIN_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.NOMINATIM_MIN_INTERVAL_MS) || 1100
);
const CACHE_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.NOMINATIM_CACHE_TTL_MS) || 30 * 24 * 60 * 60 * 1000
);

/** @type {Map<string, { lat: number, lng: number, at: number }>} */
const queryCache = new Map();
let lastRequestAt = 0;
/** Serialize outbound Nominatim calls */
let chain = Promise.resolve();

function cleanPart(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function buildGeocodeKey(addr) {
  const parts = [
    cleanPart(addr.houseNumber),
    cleanPart(addr.building),
    cleanPart(addr.floor),
    cleanPart(addr.area),
    cleanPart(addr.landmark),
    cleanPart(addr.addressLine1),
    cleanPart(addr.city),
    cleanPart(addr.state),
    String(addr.postalCode || '')
      .replace(/\D/g, '')
      .slice(0, 6),
    cleanPart(addr.country) || 'India'
  ];
  return crypto.createHash('sha256').update(parts.join('|').toLowerCase()).digest('hex').slice(0, 32);
}

function buildSearchQuery(addr) {
  return [
    cleanPart(addr.houseNumber),
    cleanPart(addr.building),
    cleanPart(addr.area),
    cleanPart(addr.landmark),
    cleanPart(addr.addressLine1),
    cleanPart(addr.city),
    cleanPart(addr.state),
    String(addr.postalCode || '')
      .replace(/\D/g, '')
      .slice(0, 6),
    cleanPart(addr.country) || 'India'
  ]
    .filter(Boolean)
    .join(', ');
}

function hasValidCoords(location) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function getCached(query) {
  const hit = queryCache.get(query);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    queryCache.delete(query);
    return null;
  }
  return { lat: hit.lat, lng: hit.lng };
}

function setCache(query, lat, lng) {
  queryCache.set(query, { lat, lng, at: Date.now() });
  // Soft bound memory
  if (queryCache.size > 2000) {
    const first = queryCache.keys().next().value;
    if (first) queryCache.delete(first);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nominatimSearch(query) {
  const cached = getCached(query);
  if (cached) return cached;

  const run = async () => {
    const again = getCached(query);
    if (again) return again;

    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'in');

    lastRequestAt = Date.now();
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      logger.warn('[addressGeocode] Nominatim HTTP error', { status: res.status });
      return null;
    }

    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : null;
    const lat = Number(row?.lat);
    const lng = Number(row?.lon ?? row?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    setCache(query, lat, lng);
    return { lat, lng };
  };

  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Resolve coords for an address plain object when Same Day pin allowlisted.
 * Does not throw. Returns { lat, lng, geocodeKey, geocodedAt } or null.
 */
async function resolveCoordsForSameDayAddress(addr, storefront = 'ecomm') {
  try {
    const pin = String(addr?.postalCode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (pin.length !== 6) return null;

    const cfg = await sameDayDeliveryService.getConfigForStorefront(storefront);
    if (!cfg.enabled || !sameDayDeliveryService.isPincodeAllowed(pin, cfg)) {
      return null;
    }

    const geocodeKey = buildGeocodeKey(addr);
    if (hasValidCoords(addr.location) && String(addr.location.geocodeKey || '') === geocodeKey) {
      return {
        lat: Number(addr.location.lat),
        lng: Number(addr.location.lng),
        geocodeKey,
        geocodedAt: addr.location.geocodedAt || new Date()
      };
    }

    const query = buildSearchQuery(addr);
    if (!query || query.length < 8) return null;

    const hit = await nominatimSearch(query);
    if (!hit) return null;

    return {
      lat: hit.lat,
      lng: hit.lng,
      geocodeKey,
      geocodedAt: new Date()
    };
  } catch (err) {
    logger.warn('[addressGeocode] resolve soft-failed', { message: err?.message });
    return null;
  }
}

/**
 * Best-effort: geocode + persist on Address mongoose doc when needed.
 * Never throws; never blocks caller on Nominatim failure.
 */
async function ensureAddressGeocodedForSameDay(addressDoc, storefront = 'ecomm') {
  if (!addressDoc) return addressDoc;
  try {
    const plain = typeof addressDoc.toObject === 'function' ? addressDoc.toObject() : addressDoc;
    const coords = await resolveCoordsForSameDayAddress(plain, storefront);
    if (!coords) return addressDoc;

    const same =
      hasValidCoords(addressDoc.location) &&
      Number(addressDoc.location.lat) === coords.lat &&
      Number(addressDoc.location.lng) === coords.lng &&
      String(addressDoc.location.geocodeKey || '') === coords.geocodeKey;
    if (same) return addressDoc;

    addressDoc.location = {
      lat: coords.lat,
      lng: coords.lng,
      geocodeKey: coords.geocodeKey,
      geocodedAt: coords.geocodedAt
    };

    if (typeof addressDoc.save === 'function') {
      await addressDoc.save();
    } else if (addressDoc._id) {
      const Address = require('../models/Address');
      await Address.updateOne(
        { _id: addressDoc._id },
        {
          $set: {
            location: {
              lat: coords.lat,
              lng: coords.lng,
              geocodeKey: coords.geocodeKey,
              geocodedAt: coords.geocodedAt
            }
          }
        }
      );
    }
    return addressDoc;
  } catch (err) {
    logger.warn('[addressGeocode] ensure persist soft-failed', { message: err?.message });
    return addressDoc;
  }
}

module.exports = {
  buildGeocodeKey,
  buildSearchQuery,
  resolveCoordsForSameDayAddress,
  ensureAddressGeocodedForSameDay
};
