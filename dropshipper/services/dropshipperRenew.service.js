'use strict';

/**
 * Phase E — subscription renew (pay current admin fee → +1 year, no admin approval).
 * Isolated dropshipper channel — does not touch ecomm User/checkout.
 */

const mongoose = require('mongoose');
const Dropshipper = require('../models/Dropshipper');
const DropshipperRegistrationRequest = require('../models/DropshipperRegistrationRequest');
const settingsService = require('./dropshipperSettings.service');
const {
  DROPSHIPPER_STATUS,
  REQUEST_ADMIN_STATUS,
  REQUEST_PAYMENT_STATUS,
  SUBSCRIPTION_YEARS,
  DROPSHIP_CHANNEL
} = require('../constants/dropshipperAuth');
const { createDropshipperError } = require('../utils/dropshipperHttp');
const {
  getRazorpayClient,
  verifyPaymentSignature,
  amountInrToPaise
} = require('../utils/dropshipperRazorpay');
const { serializeRequest } = require('./dropshipperRequest.service');
const { serializeDropshipper } = require('./dropshipperAccount.service');
const { computeSubscriptionWindow } = require('./dropshipperActivate.service');
const { subscriptionView } = require('./dropshipperLogin.service');
const logger = require('../../utils/logger');

const RENEWABLE_STATUSES = new Set([
  DROPSHIPPER_STATUS.ACTIVE,
  DROPSHIPPER_STATUS.EXPIRED
]);

async function loadRenewableDropshipper(dropshipperId) {
  if (!dropshipperId || !mongoose.Types.ObjectId.isValid(String(dropshipperId))) {
    throw createDropshipperError(401, 'UNAUTHORIZED', 'Dropshipper login required');
  }
  const doc = await Dropshipper.findById(dropshipperId);
  if (!doc) {
    throw createDropshipperError(404, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper not found');
  }
  if (!RENEWABLE_STATUSES.has(doc.status)) {
    throw createDropshipperError(
      403,
      'RENEW_NOT_ALLOWED',
      `Account status "${doc.status}" cannot renew`,
      { status: doc.status }
    );
  }
  return doc;
}

/** Live renew fee (current admin setting) — independent of registrationOpen. */
async function getRenewFeeInr() {
  const settings = await settingsService.getPublicSettings();
  const amount = Number(settings.subscriptionAmountInr);
  if (!Number.isFinite(amount) || amount < 1) {
    throw createDropshipperError(500, 'INVALID_SETTINGS', 'Subscription amount is not configured');
  }
  return amount;
}

/**
 * Preview renew quote for logged-in dropshipper.
 */
async function getRenewQuote(dropshipperId) {
  const dropshipper = await loadRenewableDropshipper(dropshipperId);
  const amountInr = await getRenewFeeInr();
  const sub = subscriptionView(dropshipper);
  const now = new Date();
  const currentEnd = dropshipper.subscription?.endsAt
    ? new Date(dropshipper.subscription.endsAt)
    : null;
  const extendFrom =
    currentEnd && !Number.isNaN(currentEnd.getTime()) && currentEnd.getTime() > now.getTime()
      ? currentEnd
      : now;
  const preview = computeSubscriptionWindow(extendFrom, SUBSCRIPTION_YEARS);

  return {
    channel: DROPSHIP_CHANNEL,
    dropshipperId: String(dropshipper._id),
    subscription: {
      ...sub,
      amountInr,
      years: SUBSCRIPTION_YEARS,
      currency: 'INR',
      renewExtendsFrom: extendFrom,
      newEndsAtPreview: preview.endsAt
    },
    nextStep: 'create_renew_payment'
  };
}

/**
 * Create renewal request + Razorpay order at current fee.
 * No admin approval required after payment (auto-activate on verify).
 */
async function createRenewPayment(dropshipperId) {
  const dropshipper = await loadRenewableDropshipper(dropshipperId);
  const amountInr = await getRenewFeeInr();
  const amountPaise = amountInrToPaise(amountInr);

  const { client: razorpay, keyId, missingEnv } = getRazorpayClient();
  if (missingEnv || !razorpay) {
    throw createDropshipperError(
      503,
      'MISSING_RAZORPAY_ENV',
      'Server env: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET'
    );
  }

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  let request = await DropshipperRegistrationRequest.findOne({
    dropshipperId: dropshipper._id,
    kind: 'renewal',
    'payment.status': REQUEST_PAYMENT_STATUS.CREATED,
    adminStatus: REQUEST_ADMIN_STATUS.PENDING,
    createdAt: { $gte: twoHoursAgo }
  }).sort({ createdAt: -1 });

  if (!request) {
    request = new DropshipperRegistrationRequest({
      fullName: dropshipper.fullName,
      email: dropshipper.email,
      phone: dropshipper.phone,
      businessName: dropshipper.businessName || null,
      amountDueInr: amountInr,
      amountPaidInr: 0,
      planYears: SUBSCRIPTION_YEARS,
      kind: 'renewal',
      payment: {
        status: REQUEST_PAYMENT_STATUS.CREATED,
        currency: 'INR',
        amountPaise
      },
      adminStatus: REQUEST_ADMIN_STATUS.PENDING,
      dropshipperId: dropshipper._id,
      channel: DROPSHIP_CHANNEL
    });
  } else {
    request.amountDueInr = amountInr;
    request.planYears = SUBSCRIPTION_YEARS;
    request.payment = request.payment || {};
    request.payment.status = REQUEST_PAYMENT_STATUS.CREATED;
    request.payment.amountPaise = amountPaise;
    request.payment.currency = 'INR';
  }

  try {
    await request.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw createDropshipperError(
        409,
        'DUPLICATE_REQUEST',
        'Could not create renew request. Please retry.'
      );
    }
    throw err;
  }

  let razorpayOrder;
  try {
    razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `dsren_${String(request._id).slice(-10)}`.slice(0, 40),
      payment_capture: 1,
      notes: {
        channel: DROPSHIP_CHANNEL,
        kind: 'renewal',
        requestId: String(request._id),
        dropshipperId: String(dropshipper._id)
      }
    });
  } catch (rzErr) {
    logger.error('[dropshipperRenew] Razorpay order create failed', {
      requestId: String(request._id),
      message: rzErr?.message
    });
    const bodyErr = rzErr && (rzErr.error || rzErr);
    throw createDropshipperError(
      502,
      'RAZORPAY_ORDER_FAILED',
      (bodyErr && (bodyErr.description || bodyErr.message)) ||
        rzErr?.message ||
        'Razorpay rejected renew payment order'
    );
  }

  request.payment.razorpayOrderId = razorpayOrder.id;
  request.payment.amountPaise = Number(razorpayOrder.amount) || amountPaise;
  request.markModified('payment');
  await request.save();

  logger.info('[dropshipperRenew] Payment order created', {
    requestId: String(request._id),
    dropshipperId: String(dropshipper._id),
    razorpayOrderId: razorpayOrder.id,
    amountInr
  });

  return {
    requestId: String(request._id),
    channel: DROPSHIP_CHANNEL,
    subscription: {
      amountInr,
      amountPaise: Number(razorpayOrder.amount) || amountPaise,
      years: SUBSCRIPTION_YEARS,
      currency: 'INR'
    },
    razorpay: {
      keyId,
      orderId: razorpayOrder.id,
      amount: Number(razorpayOrder.amount),
      currency: razorpayOrder.currency || 'INR',
      receipt: razorpayOrder.receipt || null
    },
    request: serializeRequest(request),
    dropshipper: serializeDropshipper(dropshipper)
  };
}

/**
 * Verify Razorpay renew payment → extend endsAt by 1 year, set ACTIVE.
 * No admin approval step.
 */
async function verifyRenewPayment(dropshipperId, body = {}) {
  const dropshipper = await loadRenewableDropshipper(dropshipperId);

  const requestId = String(body.requestId || body.id || '').trim();
  const razorpayOrderId = String(body.razorpay_order_id || body.razorpayOrderId || '').trim();
  const razorpayPaymentId = String(
    body.razorpay_payment_id || body.razorpayPaymentId || ''
  ).trim();
  const razorpaySignature = String(
    body.razorpay_signature || body.razorpaySignature || ''
  ).trim();

  if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Valid requestId is required');
  }

  verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });

  const request = await DropshipperRegistrationRequest.findById(requestId);
  if (!request || request.kind !== 'renewal') {
    throw createDropshipperError(404, 'REQUEST_NOT_FOUND', 'Renew request not found');
  }
  if (String(request.dropshipperId || '') !== String(dropshipper._id)) {
    throw createDropshipperError(403, 'ACCESS_DENIED', 'Renew request does not belong to this account');
  }
  if (request.channel && request.channel !== DROPSHIP_CHANNEL) {
    throw createDropshipperError(400, 'CHANNEL_MISMATCH', 'Invalid request channel');
  }

  // Idempotent
  if (
    request.payment?.status === REQUEST_PAYMENT_STATUS.PAID &&
    request.payment?.razorpayPaymentId === razorpayPaymentId &&
    dropshipper.status === DROPSHIPPER_STATUS.ACTIVE
  ) {
    return {
      alreadyProcessed: true,
      message: 'Renewal already applied',
      request: serializeRequest(request),
      dropshipper: serializeDropshipper(dropshipper),
      subscription: subscriptionView(dropshipper),
      nextStep: 'panel'
    };
  }

  if (
    request.payment?.razorpayOrderId &&
    request.payment.razorpayOrderId !== razorpayOrderId
  ) {
    throw createDropshipperError(
      400,
      'PAYMENT_ORDER_MISMATCH',
      'Payment does not match this renew request'
    );
  }

  const { client: razorpay, missingEnv } = getRazorpayClient();
  if (missingEnv || !razorpay) {
    throw createDropshipperError(503, 'MISSING_RAZORPAY_ENV', 'Razorpay not configured');
  }

  let payment;
  let rpOrder;
  try {
    payment = await razorpay.payments.fetch(razorpayPaymentId);
    rpOrder = await razorpay.orders.fetch(razorpayOrderId);
  } catch (fetchErr) {
    logger.error('[dropshipperRenew] Razorpay fetch failed', {
      requestId,
      message: fetchErr?.message
    });
    throw createDropshipperError(
      502,
      'RAZORPAY_FETCH_FAILED',
      'Could not verify payment with Razorpay'
    );
  }

  if (payment.order_id && payment.order_id !== razorpayOrderId) {
    throw createDropshipperError(400, 'PAYMENT_ORDER_MISMATCH', 'Payment and order mismatch');
  }
  if (rpOrder?.notes?.requestId && String(rpOrder.notes.requestId) !== requestId) {
    throw createDropshipperError(400, 'PAYMENT_NOT_LINKED', 'Razorpay order not linked to renew');
  }
  if (rpOrder?.notes?.kind && rpOrder.notes.kind !== 'renewal') {
    throw createDropshipperError(400, 'INVALID_REQUEST_KIND', 'Not a renewal payment');
  }
  if (
    rpOrder?.notes?.dropshipperId &&
    String(rpOrder.notes.dropshipperId) !== String(dropshipper._id)
  ) {
    throw createDropshipperError(400, 'PAYMENT_NOT_LINKED', 'Payment not linked to this dropshipper');
  }

  const expectedPaise = Number(rpOrder.amount);
  const paidPaise = Number(payment.amount);
  const duePaise = amountInrToPaise(request.amountDueInr);
  if (
    !Number.isFinite(paidPaise) ||
    !Number.isFinite(expectedPaise) ||
    paidPaise !== expectedPaise ||
    paidPaise !== duePaise
  ) {
    throw createDropshipperError(
      400,
      'PAYMENT_AMOUNT_MISMATCH',
      'Paid amount does not match renew fee'
    );
  }

  if (payment.status === 'authorized') {
    throw createDropshipperError(
      409,
      'PAYMENT_NOT_CAPTURED_YET',
      'Payment is authorized but not captured yet. Retry shortly.'
    );
  }
  if (payment.status !== 'captured') {
    throw createDropshipperError(
      400,
      'PAYMENT_NOT_COMPLETED',
      `Payment not completed (status: ${payment.status})`
    );
  }

  const paymentClash = await DropshipperRegistrationRequest.findOne({
    _id: { $ne: request._id },
    'payment.razorpayPaymentId': razorpayPaymentId
  })
    .select('_id')
    .lean();
  if (paymentClash) {
    throw createDropshipperError(
      409,
      'PAYMENT_ALREADY_USED',
      'This Razorpay payment is already linked to another request'
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Re-load dropshipper in transaction
    const ds = await Dropshipper.findById(dropshipper._id).session(session);
    if (!ds) {
      throw createDropshipperError(404, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper not found');
    }

    const now = new Date();
    const currentEnd = ds.subscription?.endsAt ? new Date(ds.subscription.endsAt) : null;
    const extendFrom =
      currentEnd && !Number.isNaN(currentEnd.getTime()) && currentEnd.getTime() > now.getTime()
        ? currentEnd
        : now;
    const { endsAt } = computeSubscriptionWindow(extendFrom, SUBSCRIPTION_YEARS);
    const startsAt = ds.subscription?.startsAt || now;

    ds.subscription = ds.subscription || {};
    ds.subscription.startsAt = startsAt;
    ds.subscription.endsAt = endsAt;
    ds.subscription.planYears = SUBSCRIPTION_YEARS;
    ds.subscription.amountPaidInr = request.amountDueInr;
    ds.subscription.lastPaymentId = razorpayPaymentId;
    ds.subscription.lastRazorpayOrderId = razorpayOrderId;
    ds.subscription.renewedAt = now;
    ds.status = DROPSHIPPER_STATUS.ACTIVE;
    ds.markModified('subscription');
    await ds.save({ session });

    request.payment = request.payment || {};
    request.payment.status = REQUEST_PAYMENT_STATUS.PAID;
    request.payment.razorpayOrderId = razorpayOrderId;
    request.payment.razorpayPaymentId = razorpayPaymentId;
    request.payment.razorpaySignature = razorpaySignature;
    request.payment.amountPaise = paidPaise;
    request.payment.paidAt = now;
    request.payment.currency = 'INR';
    request.amountPaidInr = request.amountDueInr;
    request.adminStatus = REQUEST_ADMIN_STATUS.APPROVED;
    request.decidedAt = now;
    request.decisionNote = 'auto_approved_renewal';
    request.dropshipperId = ds._id;
    request.markModified('payment');
    await request.save({ session });

    await session.commitTransaction();
    session.endSession();

    logger.info('[dropshipperRenew] Renewed', {
      dropshipperId: String(ds._id),
      requestId: String(request._id),
      endsAt,
      amountInr: request.amountPaidInr
    });

    return {
      alreadyProcessed: false,
      message: 'Subscription renewed for 1 year. Panel access restored.',
      request: serializeRequest(request),
      dropshipper: serializeDropshipper(ds),
      subscription: subscriptionView(ds),
      nextStep: 'panel',
      channel: DROPSHIP_CHANNEL
    };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    if (err?.statusCode) throw err;
    if (err?.code === 11000) {
      throw createDropshipperError(
        409,
        'PAYMENT_ALREADY_USED',
        'This Razorpay payment is already linked to another request'
      );
    }
    logger.error('[dropshipperRenew] verify failed', { message: err?.message });
    throw createDropshipperError(500, 'RENEW_FAILED', 'Failed to apply renewal');
  }
}

module.exports = {
  getRenewQuote,
  createRenewPayment,
  verifyRenewPayment
};
