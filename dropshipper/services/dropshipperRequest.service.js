'use strict';

/**
 * Registration / renew requests — admin list + approve/reject (Phase A).
 * OTP / password activation continues in later phases after approve.
 */

const mongoose = require('mongoose');
const Dropshipper = require('../models/Dropshipper');
const DropshipperRegistrationRequest = require('../models/DropshipperRegistrationRequest');
const {
  DROPSHIPPER_STATUS,
  REQUEST_ADMIN_STATUS,
  REQUEST_PAYMENT_STATUS,
  SUBSCRIPTION_YEARS,
  DROPSHIP_CHANNEL
} = require('../constants/dropshipperAuth');
const { parsePagination } = require('../utils/dropshipperValidators');
const { createDropshipperError } = require('../utils/dropshipperHttp');
const logger = require('../../utils/logger');

function serializeRequest(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(o._id),
    fullName: o.fullName,
    email: o.email,
    phone: o.phone,
    businessName: o.businessName || null,
    whatsappNumber: o.whatsappNumber || null,
    application: {
      permanentAddress: o.application?.permanentAddress || '',
      haveShop: o.application?.haveShop === true,
      businessAddress: o.application?.businessAddress || '',
      deliveryAddress: o.application?.deliveryAddress || '',
      sellingPlaceFrom: o.application?.sellingPlaceFrom || '',
      sellingZoneCity: o.application?.sellingZoneCity || '',
      productCategory: o.application?.productCategory || '',
      monthlyEstimatedPurchase:
        o.application?.monthlyEstimatedPurchase != null
          ? Number(o.application.monthlyEstimatedPurchase)
          : null,
      idProofUrl: o.application?.idProofUrl || '',
      businessAddressProofUrl: o.application?.businessAddressProofUrl || ''
    },
    kind: o.kind || 'registration',
    amountDueInr: o.amountDueInr,
    amountPaidInr: o.amountPaidInr,
    planYears: o.planYears ?? SUBSCRIPTION_YEARS,
    payment: {
      status: o.payment?.status || null,
      razorpayOrderId: o.payment?.razorpayOrderId || null,
      razorpayPaymentId: o.payment?.razorpayPaymentId || null,
      amountPaise: o.payment?.amountPaise ?? null,
      currency: o.payment?.currency || 'INR',
      paidAt: o.payment?.paidAt || null
    },
    adminStatus: o.adminStatus,
    decidedBy: o.decidedBy ? String(o.decidedBy) : null,
    decidedAt: o.decidedAt || null,
    decisionNote: o.decisionNote || null,
    dropshipperId: o.dropshipperId ? String(o.dropshipperId) : null,
    channel: o.channel || DROPSHIP_CHANNEL,
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null
  };
}

async function listRequests({ page, limit, adminStatus, kind, q } = {}) {
  const paging = parsePagination({ page, limit });
  const filter = {};

  if (adminStatus && String(adminStatus).toLowerCase() !== 'all') {
    const st = String(adminStatus).toLowerCase().trim();
    if (!Object.values(REQUEST_ADMIN_STATUS).includes(st)) {
      throw createDropshipperError(400, 'VALIDATION_ERROR', `Invalid adminStatus: ${adminStatus}`);
    }
    filter.adminStatus = st;
  }

  if (kind && String(kind).toLowerCase() !== 'all') {
    const k = String(kind).toLowerCase().trim();
    if (k !== 'registration' && k !== 'renewal') {
      throw createDropshipperError(400, 'VALIDATION_ERROR', 'kind must be registration or renewal');
    }
    filter.kind = k;
  }

  const query = String(q || '').trim();
  if (query) {
    const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { fullName: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
      { 'payment.razorpayPaymentId': { $regex: safe, $options: 'i' } },
      { 'payment.razorpayOrderId': { $regex: safe, $options: 'i' } }
    ];
  }

  const [rows, total] = await Promise.all([
    DropshipperRegistrationRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .lean(),
    DropshipperRegistrationRequest.countDocuments(filter)
  ]);

  return {
    requests: rows.map(serializeRequest),
    page: paging.page,
    limit: paging.limit,
    total,
    totalPages: Math.ceil(total / paging.limit) || 1
  };
}

async function getRequestById(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Invalid request id');
  }
  const doc = await DropshipperRegistrationRequest.findById(id).lean();
  if (!doc) {
    throw createDropshipperError(404, 'REQUEST_NOT_FOUND', 'Registration request not found');
  }
  return serializeRequest(doc);
}

/**
 * Approve a paid pending registration request.
 * Creates / links Dropshipper in pending_otp (OTP + password in later phase).
 */
async function approveRequest(requestId, adminUserId, { note } = {}) {
  if (!adminUserId || !mongoose.Types.ObjectId.isValid(String(adminUserId))) {
    throw createDropshipperError(401, 'UNAUTHORIZED', 'Admin authentication required');
  }
  if (!requestId || !mongoose.Types.ObjectId.isValid(String(requestId))) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Invalid request id');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const request = await DropshipperRegistrationRequest.findById(requestId).session(session);
    if (!request) {
      throw createDropshipperError(404, 'REQUEST_NOT_FOUND', 'Registration request not found');
    }

    if (request.adminStatus === REQUEST_ADMIN_STATUS.APPROVED) {
      await session.abortTransaction();
      session.endSession();
      const existing = request.dropshipperId
        ? await Dropshipper.findById(request.dropshipperId).lean()
        : null;
      return {
        request: serializeRequest(request),
        dropshipper: existing
          ? require('./dropshipperAccount.service').serializeDropshipper(existing)
          : null,
        alreadyProcessed: true
      };
    }

    if (request.adminStatus === REQUEST_ADMIN_STATUS.REJECTED) {
      throw createDropshipperError(
        409,
        'REQUEST_ALREADY_REJECTED',
        'This request was already rejected'
      );
    }

    if (request.payment?.status !== REQUEST_PAYMENT_STATUS.PAID) {
      throw createDropshipperError(
        409,
        'PAYMENT_NOT_PAID',
        'Cannot approve a request that is not paid'
      );
    }

    let dropshipper = null;
    if (request.dropshipperId) {
      dropshipper = await Dropshipper.findById(request.dropshipperId).session(session);
    }
    if (!dropshipper) {
      dropshipper = await Dropshipper.findOne({
        $or: [{ email: request.email }, { phone: request.phone }]
      }).session(session);
    }

    if (dropshipper && dropshipper.status === DROPSHIPPER_STATUS.ACTIVE) {
      throw createDropshipperError(
        409,
        'DROPSHIPPER_ALREADY_ACTIVE',
        'An active dropshipper already exists for this email/phone'
      );
    }

    if (!dropshipper) {
      const created = await Dropshipper.create(
        [
          {
            fullName: request.fullName,
            email: request.email,
            phone: request.phone,
            businessName: request.businessName || null,
            whatsappNumber: request.whatsappNumber || null,
            application: request.application || {},
            status: DROPSHIPPER_STATUS.PENDING_OTP,
            registrationRequestId: request._id,
            approvedAt: new Date(),
            approvedBy: adminUserId,
            channel: DROPSHIP_CHANNEL,
            subscription: {
              amountPaidInr: request.amountPaidInr || request.amountDueInr,
              planYears: request.planYears || SUBSCRIPTION_YEARS,
              lastPaymentId: request.payment?.razorpayPaymentId || null,
              lastRazorpayOrderId: request.payment?.razorpayOrderId || null
              // startsAt/endsAt set when password+OTP complete (Phase C)
            }
          }
        ],
        { session }
      );
      dropshipper = created[0];
    } else {
      dropshipper.fullName = request.fullName;
      dropshipper.businessName = request.businessName || dropshipper.businessName;
      dropshipper.whatsappNumber = request.whatsappNumber || dropshipper.whatsappNumber;
      dropshipper.application = request.application || dropshipper.application || {};
      dropshipper.markModified('application');
      dropshipper.status = DROPSHIPPER_STATUS.PENDING_OTP;
      dropshipper.registrationRequestId = request._id;
      dropshipper.approvedAt = new Date();
      dropshipper.approvedBy = adminUserId;
      dropshipper.rejectedAt = null;
      dropshipper.rejectedBy = null;
      dropshipper.rejectionNote = null;
      dropshipper.subscription = dropshipper.subscription || {};
      dropshipper.subscription.amountPaidInr =
        request.amountPaidInr || request.amountDueInr;
      dropshipper.subscription.planYears = request.planYears || SUBSCRIPTION_YEARS;
      dropshipper.subscription.lastPaymentId =
        request.payment?.razorpayPaymentId || dropshipper.subscription.lastPaymentId;
      dropshipper.subscription.lastRazorpayOrderId =
        request.payment?.razorpayOrderId || dropshipper.subscription.lastRazorpayOrderId;
      await dropshipper.save({ session });
    }

    request.adminStatus = REQUEST_ADMIN_STATUS.APPROVED;
    request.decidedBy = adminUserId;
    request.decidedAt = new Date();
    request.decisionNote = note ? String(note).trim().slice(0, 500) : null;
    request.dropshipperId = dropshipper._id;
    await request.save({ session });

    await session.commitTransaction();
    session.endSession();

    logger.info('[dropshipperRequest] Approved', {
      requestId: String(request._id),
      dropshipperId: String(dropshipper._id),
      adminUserId: String(adminUserId)
    });

    // Best-effort: email activation OTP (never fails approve)
    setImmediate(() => {
      require('./dropshipperActivate.service')
        .trySendOtpAfterApprove(dropshipper._id)
        .catch(() => {});
    });

    return {
      request: serializeRequest(request),
      dropshipper: require('./dropshipperAccount.service').serializeDropshipper(dropshipper),
      alreadyProcessed: false,
      nextStep: 'otp_and_password',
      otpHint: 'Activation OTP will be sent to the registered email (if SMTP configured).'
    };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    if (err?.statusCode) throw err;
    if (err?.code === 11000) {
      throw createDropshipperError(
        409,
        'DUPLICATE_DROPSHIPPER',
        'Email or phone already registered as dropshipper'
      );
    }
    logger.error('[dropshipperRequest] approve failed', { message: err?.message });
    throw createDropshipperError(500, 'APPROVE_FAILED', 'Failed to approve request');
  }
}

async function rejectRequest(requestId, adminUserId, { note } = {}) {
  if (!adminUserId || !mongoose.Types.ObjectId.isValid(String(adminUserId))) {
    throw createDropshipperError(401, 'UNAUTHORIZED', 'Admin authentication required');
  }
  if (!requestId || !mongoose.Types.ObjectId.isValid(String(requestId))) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Invalid request id');
  }

  const noteText = note != null ? String(note).trim().slice(0, 500) : '';
  if (!noteText) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Rejection note is required');
  }

  const request = await DropshipperRegistrationRequest.findById(requestId);
  if (!request) {
    throw createDropshipperError(404, 'REQUEST_NOT_FOUND', 'Registration request not found');
  }

  if (request.adminStatus === REQUEST_ADMIN_STATUS.REJECTED) {
    return { request: serializeRequest(request), alreadyProcessed: true };
  }

  if (request.adminStatus === REQUEST_ADMIN_STATUS.APPROVED) {
    throw createDropshipperError(
      409,
      'REQUEST_ALREADY_APPROVED',
      'Approved requests cannot be rejected here'
    );
  }

  request.adminStatus = REQUEST_ADMIN_STATUS.REJECTED;
  request.decidedBy = adminUserId;
  request.decidedAt = new Date();
  request.decisionNote = noteText;
  await request.save();

  // If a shell account exists in pending states, mark rejected too.
  if (request.dropshipperId) {
    try {
      await Dropshipper.updateOne(
        {
          _id: request.dropshipperId,
          status: {
            $in: [
              DROPSHIPPER_STATUS.PENDING_ADMIN,
              DROPSHIPPER_STATUS.PENDING_OTP,
              DROPSHIPPER_STATUS.PENDING_PAYMENT
            ]
          }
        },
        {
          $set: {
            status: DROPSHIPPER_STATUS.REJECTED,
            rejectedAt: new Date(),
            rejectedBy: adminUserId,
            rejectionNote: noteText
          }
        }
      );
    } catch (linkErr) {
      logger.warn('[dropshipperRequest] reject link update failed', {
        message: linkErr?.message,
        requestId: String(request._id)
      });
    }
  }

  logger.info('[dropshipperRequest] Rejected', {
    requestId: String(request._id),
    adminUserId: String(adminUserId)
  });

  return { request: serializeRequest(request), alreadyProcessed: false };
}

module.exports = {
  listRequests,
  getRequestById,
  approveRequest,
  rejectRequest,
  serializeRequest
};
