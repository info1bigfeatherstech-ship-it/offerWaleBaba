'use strict';

/**
 * Dropshipper registration + subscription fee payment (Phase B).
 * Isolated — does not touch ecomm User / checkout / storefront settings.
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
const {
  assertEmail,
  assertPhone,
  assertFullName,
  parseApplicationDetails
} = require('../utils/dropshipperValidators');
const { createDropshipperError } = require('../utils/dropshipperHttp');
const {
  getRazorpayClient,
  verifyPaymentSignature,
  amountInrToPaise
} = require('../utils/dropshipperRazorpay');
const { serializeRequest } = require('./dropshipperRequest.service');
const logger = require('../../utils/logger');

const BLOCKING_ACCOUNT_STATUSES = new Set([
  DROPSHIPPER_STATUS.ACTIVE,
  DROPSHIPPER_STATUS.PENDING_OTP,
  DROPSHIPPER_STATUS.PENDING_ADMIN,
  DROPSHIPPER_STATUS.PENDING_PAYMENT,
  DROPSHIPPER_STATUS.SUSPENDED
]);

function parseApplicant(body = {}) {
  const fullName = assertFullName(body.fullName || body.name);
  const email = assertEmail(body.email);
  const phone = assertPhone(body.phone || body.mobileNumber);
  const businessNameRaw = body.businessName != null ? String(body.businessName).trim() : '';
  const businessName = businessNameRaw ? businessNameRaw.slice(0, 160) : null;
  const details = parseApplicationDetails({ ...body, phone });
  return {
    fullName,
    email,
    phone,
    businessName,
    whatsappNumber: details.whatsappNumber,
    application: details.application
  };
}

async function assertApplicantAvailable(email, phone) {
  const existingAccount = await Dropshipper.findOne({
    $or: [{ email }, { phone }],
    status: { $in: [...BLOCKING_ACCOUNT_STATUSES] }
  })
    .select('_id status email phone')
    .lean();

  if (existingAccount) {
    throw createDropshipperError(
      409,
      'DROPSHIPPER_EXISTS',
      'A dropshipper account already exists for this email or phone',
      { status: existingAccount.status }
    );
  }

  const pendingPaid = await DropshipperRegistrationRequest.findOne({
    $or: [{ email }, { phone }],
    kind: 'registration',
    adminStatus: REQUEST_ADMIN_STATUS.PENDING,
    'payment.status': REQUEST_PAYMENT_STATUS.PAID
  })
    .select('_id email phone createdAt')
    .lean();

  if (pendingPaid) {
    throw createDropshipperError(
      409,
      'REQUEST_ALREADY_SUBMITTED',
      'A paid registration request is already pending admin approval for this email/phone',
      { requestId: String(pendingPaid._id) }
    );
  }
}

/**
 * Preview registration fee + openness (no DB write).
 */
async function startRegistration(body = {}) {
  const applicant = parseApplicant(body);
  await assertApplicantAvailable(applicant.email, applicant.phone);

  const settings = await settingsService.getPublicSettings();
  if (settings.registrationOpen === false) {
    throw createDropshipperError(
      403,
      'REGISTRATION_CLOSED',
      'Dropshipper registration is temporarily closed'
    );
  }

  return {
    channel: DROPSHIP_CHANNEL,
    applicant: {
      fullName: applicant.fullName,
      email: applicant.email,
      phone: applicant.phone,
      businessName: applicant.businessName,
      whatsappNumber: applicant.whatsappNumber,
      application: applicant.application
    },
    subscription: {
      amountInr: settings.subscriptionAmountInr,
      years: SUBSCRIPTION_YEARS,
      currency: 'INR'
    },
    nextStep: 'create_payment'
  };
}

/**
 * Create registration request + Razorpay order for current subscription fee.
 */
async function createRegistrationPayment(body = {}) {
  const applicant = parseApplicant(body);
  await assertApplicantAvailable(applicant.email, applicant.phone);

  const amountInr = await settingsService.getCurrentSubscriptionAmountInr();
  const amountPaise = amountInrToPaise(amountInr);

  const { client: razorpay, keyId, missingEnv } = getRazorpayClient();
  if (missingEnv || !razorpay) {
    throw createDropshipperError(
      503,
      'MISSING_RAZORPAY_ENV',
      'Server env: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET'
    );
  }

  // Reuse unpaid draft for same email+phone within 2h to avoid request spam
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  let request = await DropshipperRegistrationRequest.findOne({
    email: applicant.email,
    phone: applicant.phone,
    kind: 'registration',
    adminStatus: REQUEST_ADMIN_STATUS.PENDING,
    'payment.status': REQUEST_PAYMENT_STATUS.CREATED,
    createdAt: { $gte: twoHoursAgo }
  }).sort({ createdAt: -1 });

  if (!request) {
    request = new DropshipperRegistrationRequest({
      fullName: applicant.fullName,
      email: applicant.email,
      phone: applicant.phone,
      businessName: applicant.businessName,
      whatsappNumber: applicant.whatsappNumber,
      application: applicant.application,
      amountDueInr: amountInr,
      amountPaidInr: 0,
      planYears: SUBSCRIPTION_YEARS,
      kind: 'registration',
      payment: {
        status: REQUEST_PAYMENT_STATUS.CREATED,
        currency: 'INR',
        amountPaise
      },
      adminStatus: REQUEST_ADMIN_STATUS.PENDING,
      channel: DROPSHIP_CHANNEL
    });
  } else {
    // Refresh applicant snapshot + live fee (draft not paid yet)
    request.fullName = applicant.fullName;
    request.businessName = applicant.businessName;
    request.whatsappNumber = applicant.whatsappNumber;
    request.application = applicant.application;
    request.markModified('application');
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
        'Could not create registration request (duplicate payment id). Retry.'
      );
    }
    throw err;
  }

  let razorpayOrder;
  try {
    razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `dsreg_${String(request._id).slice(-10)}`.slice(0, 40),
      payment_capture: 1,
      notes: {
        channel: DROPSHIP_CHANNEL,
        kind: 'registration',
        requestId: String(request._id),
        email: applicant.email,
        phone: applicant.phone
      }
    });
  } catch (rzErr) {
    logger.error('[dropshipperRegister] Razorpay order create failed', {
      requestId: String(request._id),
      message: rzErr?.message
    });
    const bodyErr = rzErr && (rzErr.error || rzErr);
    throw createDropshipperError(
      502,
      'RAZORPAY_ORDER_FAILED',
      (bodyErr && (bodyErr.description || bodyErr.message)) ||
        rzErr?.message ||
        'Razorpay rejected subscription payment order'
    );
  }

  request.payment.razorpayOrderId = razorpayOrder.id;
  request.payment.amountPaise = Number(razorpayOrder.amount) || amountPaise;
  request.markModified('payment');
  await request.save();

  logger.info('[dropshipperRegister] Payment order created', {
    requestId: String(request._id),
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
    applicant: {
      fullName: request.fullName,
      email: request.email,
      phone: request.phone,
      businessName: request.businessName || null
    },
    razorpay: {
      keyId,
      orderId: razorpayOrder.id,
      amount: Number(razorpayOrder.amount),
      currency: razorpayOrder.currency || 'INR',
      receipt: razorpayOrder.receipt || null
    },
    request: serializeRequest(request)
  };
}

/**
 * Verify Razorpay payment and mark registration request paid → admin pending queue.
 */
async function verifyRegistrationPayment(body = {}) {
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
  if (!request) {
    throw createDropshipperError(404, 'REQUEST_NOT_FOUND', 'Registration request not found');
  }
  if (request.kind !== 'registration') {
    throw createDropshipperError(400, 'INVALID_REQUEST_KIND', 'Not a registration request');
  }
  if (request.channel && request.channel !== DROPSHIP_CHANNEL) {
    throw createDropshipperError(400, 'CHANNEL_MISMATCH', 'Invalid request channel');
  }

  // Idempotent success
  if (
    request.payment?.status === REQUEST_PAYMENT_STATUS.PAID &&
    request.payment?.razorpayPaymentId === razorpayPaymentId
  ) {
    return {
      alreadyProcessed: true,
      message: 'Payment already verified. Waiting for admin approval.',
      request: serializeRequest(request),
      nextStep: 'admin_approval'
    };
  }

  if (request.adminStatus === REQUEST_ADMIN_STATUS.REJECTED) {
    throw createDropshipperError(409, 'REQUEST_REJECTED', 'This registration was rejected');
  }
  if (request.adminStatus === REQUEST_ADMIN_STATUS.APPROVED) {
    return {
      alreadyProcessed: true,
      message: 'Registration already approved',
      request: serializeRequest(request),
      nextStep: 'otp_and_password'
    };
  }

  if (
    request.payment?.razorpayOrderId &&
    request.payment.razorpayOrderId !== razorpayOrderId
  ) {
    throw createDropshipperError(
      400,
      'PAYMENT_ORDER_MISMATCH',
      'Payment does not match this registration request'
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
    logger.error('[dropshipperRegister] Razorpay fetch failed', {
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
    throw createDropshipperError(
      400,
      'PAYMENT_NOT_LINKED',
      'Razorpay order is not linked to this registration'
    );
  }

  if (rpOrder?.notes?.channel && rpOrder.notes.channel !== DROPSHIP_CHANNEL) {
    throw createDropshipperError(400, 'CHANNEL_MISMATCH', 'Payment channel mismatch');
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
      'Paid amount does not match registration fee'
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

  // Another request already used this payment id
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

  request.payment = request.payment || {};
  request.payment.status = REQUEST_PAYMENT_STATUS.PAID;
  request.payment.razorpayOrderId = razorpayOrderId;
  request.payment.razorpayPaymentId = razorpayPaymentId;
  request.payment.razorpaySignature = razorpaySignature;
  request.payment.amountPaise = paidPaise;
  request.payment.paidAt = new Date();
  request.payment.currency = 'INR';
  request.amountPaidInr = request.amountDueInr;
  request.adminStatus = REQUEST_ADMIN_STATUS.PENDING;
  request.markModified('payment');

  try {
    await request.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw createDropshipperError(
        409,
        'PAYMENT_ALREADY_USED',
        'This Razorpay payment is already linked to another request'
      );
    }
    throw err;
  }

  logger.info('[dropshipperRegister] Payment verified — pending admin', {
    requestId: String(request._id),
    razorpayPaymentId,
    amountInr: request.amountPaidInr
  });

  return {
    alreadyProcessed: false,
    message: 'Payment verified. Your request is pending admin approval.',
    request: serializeRequest(request),
    nextStep: 'admin_approval'
  };
}

/**
 * Public status poll for applicant (by requestId + phone last-4 or email match).
 */
async function getRegistrationStatus({ requestId, email, phone } = {}) {
  if (!requestId || !mongoose.Types.ObjectId.isValid(String(requestId))) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Valid requestId is required');
  }
  const request = await DropshipperRegistrationRequest.findById(requestId).lean();
  if (!request || request.kind !== 'registration') {
    throw createDropshipperError(404, 'REQUEST_NOT_FOUND', 'Registration request not found');
  }

  const emailNorm = email ? assertEmail(email) : null;
  const phoneNorm = phone ? assertPhone(phone) : null;
  if (!emailNorm && !phoneNorm) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'email or phone is required to view status');
  }
  if (emailNorm && request.email !== emailNorm) {
    throw createDropshipperError(403, 'ACCESS_DENIED', 'Request does not match email');
  }
  if (phoneNorm && request.phone !== phoneNorm) {
    throw createDropshipperError(403, 'ACCESS_DENIED', 'Request does not match phone');
  }

  return {
    request: serializeRequest(request),
    nextStep:
      request.payment?.status !== REQUEST_PAYMENT_STATUS.PAID
        ? 'complete_payment'
        : request.adminStatus === REQUEST_ADMIN_STATUS.APPROVED
          ? 'otp_and_password'
          : request.adminStatus === REQUEST_ADMIN_STATUS.REJECTED
            ? 'rejected'
            : 'admin_approval'
  };
}

module.exports = {
  startRegistration,
  createRegistrationPayment,
  verifyRegistrationPayment,
  getRegistrationStatus,
  parseApplicant
};
