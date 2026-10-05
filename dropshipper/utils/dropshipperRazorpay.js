'use strict';

/**
 * Razorpay helpers for dropshipper subscription payments only.
 * Does not import ecomm order.controller (avoids load-time Razorpay env hard-fail).
 */

const crypto = require('crypto');
const Razorpay = require('razorpay');
const { createDropshipperError } = require('./dropshipperHttp');

function getRazorpayCredentials() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  return { keyId, keySecret };
}

function getRazorpayClient() {
  const { keyId, keySecret } = getRazorpayCredentials();
  if (!keyId || !keySecret) {
    return { client: null, keyId: null, missingEnv: true };
  }
  return {
    client: new Razorpay({ key_id: keyId, key_secret: keySecret }),
    keyId,
    missingEnv: false
  };
}

function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const { keySecret } = getRazorpayCredentials();
  if (!keySecret) {
    throw createDropshipperError(503, 'MISSING_RAZORPAY_ENV', 'Razorpay secret not configured');
  }
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw createDropshipperError(
      400,
      'PAYMENT_VERIFY_PAYLOAD_INVALID',
      'razorpay_order_id, razorpay_payment_id and razorpay_signature are required'
    );
  }
  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expected = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(razorpaySignature), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw createDropshipperError(400, 'PAYMENT_SIGNATURE_INVALID', 'Invalid payment signature');
  }
  return true;
}

function amountInrToPaise(amountInr) {
  const n = Number(amountInr);
  if (!Number.isFinite(n) || n < 1) {
    throw createDropshipperError(400, 'INVALID_AMOUNT', 'Amount must be at least ₹1');
  }
  return Math.round(n * 100);
}

module.exports = {
  getRazorpayCredentials,
  getRazorpayClient,
  verifyPaymentSignature,
  amountInrToPaise
};
