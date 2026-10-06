'use strict';

const { createDropshipperError } = require('./dropshipperHttp');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\d{10}$/;

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(-10);
  return digits.slice(-10);
}

function normalizeFullName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function assertEmail(value, fieldName = 'email') {
  const email = normalizeEmail(value);
  if (!email || !EMAIL_RE.test(email) || email.length > 180) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', `Valid ${fieldName} is required`);
  }
  return email;
}

function assertPhone(value, fieldName = 'phone') {
  const phone = normalizePhone(value);
  if (!PHONE_RE.test(phone)) {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be a valid 10-digit Indian mobile number`
    );
  }
  return phone;
}

function assertFullName(value) {
  const fullName = normalizeFullName(value);
  if (!fullName || fullName.length < 2) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'fullName is required');
  }
  return fullName;
}

function parseSubscriptionAmountInr(value) {
  if (value === undefined || value === null || value === '') {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'subscriptionAmountInr is required');
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      'subscriptionAmountInr must be a number >= 1'
    );
  }
  // Store as paise-safe rupees (2 dp max)
  return Math.round(n * 100) / 100;
}

function parsePagination(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function assertRequiredText(value, fieldName, { min = 3, max = 500 } = {}) {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text || text.length < min) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', `${fieldName} is required`);
  }
  return text.slice(0, max);
}

function parseOptionalUrl(value, fieldName) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.length > 500) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', `${fieldName} is too long`);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be a valid http(s) URL`
    );
  }
  return url;
}

function parseMonthlyEstimatedPurchase(value) {
  if (value === undefined || value === null || value === '') {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      'monthlyEstimatedPurchase is required'
    );
  }
  const n = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0) {
    throw createDropshipperError(
      400,
      'VALIDATION_ERROR',
      'monthlyEstimatedPurchase must be a number >= 0'
    );
  }
  return Math.round(n);
}

/**
 * Wholesaler-style application profile for dropshipper registration.
 * Proof URLs: set by Cloudinary upload on create-payment (multipart) or optional https URL.
 */
function parseApplicationDetails(body = {}) {
  const whatsappNumber = assertPhone(
    body.whatsappNumber || body.whatsapp || body.phone,
    'whatsappNumber'
  );
  const haveShop =
    body.haveShop === true ||
    body.haveShop === 'true' ||
    body.haveShop === 1 ||
    body.haveShop === '1';

  return {
    whatsappNumber,
    application: {
      permanentAddress: assertRequiredText(body.permanentAddress, 'permanentAddress'),
      haveShop,
      businessAddress: assertRequiredText(body.businessAddress, 'businessAddress'),
      deliveryAddress: assertRequiredText(body.deliveryAddress, 'deliveryAddress'),
      sellingPlaceFrom: assertRequiredText(body.sellingPlaceFrom, 'sellingPlaceFrom', {
        min: 2,
        max: 160
      }),
      sellingZoneCity: assertRequiredText(body.sellingZoneCity, 'sellingZoneCity', {
        min: 2,
        max: 120
      }),
      productCategory: assertRequiredText(body.productCategory, 'productCategory', {
        min: 2,
        max: 160
      }),
      monthlyEstimatedPurchase: parseMonthlyEstimatedPurchase(body.monthlyEstimatedPurchase),
      idProofUrl: parseOptionalUrl(
        body.idProofUrl || body.idProofUpload,
        'idProofUrl'
      ),
      businessAddressProofUrl: parseOptionalUrl(
        body.businessAddressProofUrl || body.businessAddressProofUpload,
        'businessAddressProofUrl'
      )
    }
  };
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  normalizeFullName,
  assertEmail,
  assertPhone,
  assertFullName,
  assertRequiredText,
  parseApplicationDetails,
  parseSubscriptionAmountInr,
  parsePagination
};
