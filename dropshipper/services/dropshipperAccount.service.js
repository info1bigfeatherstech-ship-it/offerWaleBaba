'use strict';

/**
 * Admin-facing dropshipper account list/detail.
 * Isolated — does not query ecomm User collection.
 */

const mongoose = require('mongoose');
const Dropshipper = require('../models/Dropshipper');
const { DROPSHIPPER_STATUS } = require('../constants/dropshipperAuth');
const { parsePagination } = require('../utils/dropshipperValidators');
const { createDropshipperError } = require('../utils/dropshipperHttp');

function serializeDropshipper(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const endsAt = o.subscription?.endsAt ? new Date(o.subscription.endsAt) : null;
  const now = Date.now();
  const subscriptionActive = Boolean(
    o.status === DROPSHIPPER_STATUS.ACTIVE &&
      endsAt &&
      !Number.isNaN(endsAt.getTime()) &&
      endsAt.getTime() > now
  );

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
    status: o.status,
    channel: o.channel || 'dropship',
    subscription: {
      amountPaidInr: o.subscription?.amountPaidInr ?? null,
      startsAt: o.subscription?.startsAt || null,
      endsAt: o.subscription?.endsAt || null,
      planYears: o.subscription?.planYears ?? null,
      renewedAt: o.subscription?.renewedAt || null,
      active: subscriptionActive
    },
    hasPassword: Boolean(o.passwordHash),
    registrationRequestId: o.registrationRequestId
      ? String(o.registrationRequestId)
      : null,
    approvedAt: o.approvedAt || null,
    rejectedAt: o.rejectedAt || null,
    rejectionNote: o.rejectionNote || null,
    lastLoginAt: o.lastLoginAt || null,
    passwordSetAt: o.passwordSetAt || null,
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null
  };
}

async function listDropshippers({ page, limit, status, q } = {}) {
  const paging = parsePagination({ page, limit });
  const filter = {};

  if (status && String(status).toLowerCase() !== 'all') {
    const st = String(status).toLowerCase().trim();
    if (!Object.values(DROPSHIPPER_STATUS).includes(st)) {
      throw createDropshipperError(400, 'VALIDATION_ERROR', `Invalid status: ${status}`);
    }
    filter.status = st;
  }

  const query = String(q || '').trim();
  if (query) {
    const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { fullName: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
      { businessName: { $regex: safe, $options: 'i' } }
    ];
  }

  const [rows, total] = await Promise.all([
    Dropshipper.find(filter)
      .sort({ createdAt: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .lean(),
    Dropshipper.countDocuments(filter)
  ]);

  return {
    dropshippers: rows.map(serializeDropshipper),
    page: paging.page,
    limit: paging.limit,
    total,
    totalPages: Math.ceil(total / paging.limit) || 1
  };
}

async function getDropshipperById(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Invalid dropshipper id');
  }
  const doc = await Dropshipper.findById(id).lean();
  if (!doc) {
    throw createDropshipperError(404, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper not found');
  }
  return serializeDropshipper(doc);
}

module.exports = {
  listDropshippers,
  getDropshipperById,
  serializeDropshipper
};
