const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const path = require('path');
const WholesalerDetails = require('../models/WholesalerDetails');
const User = require('../models/User');
const { generateOTP, sendOTP } = require('../services/otp.service');
const { cloudinary } = require('../config/cloudinary.config');

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';

const OWNER_REVIEW_PURPOSE = 'wholesaler_owner_review';
const OWNER_REVIEW_TOKEN_EXPIRES = process.env.OWNER_REVIEW_TOKEN_EXPIRES || '48h';

function normalizePhone(v) {
  return String(v || '').replace(/\D/g, '').slice(-10);
}

/** E.164-style digits for wa.me (India 91 + 10 digits). */
function rawDigitsToWaMePath(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(-10)}`;
  return null;
}

function hashString(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function getOwnerReviewSecret() {
  return String(process.env.OWNER_REVIEW_JWT_SECRET || process.env.JWT_SECRET || '').trim();
}

function signOwnerReviewToken(requestId, linkVersion) {
  const secret = getOwnerReviewSecret();
  if (!secret) {
    throw new Error('OWNER_REVIEW_JWT_SECRET or JWT_SECRET must be set');
  }
  return jwt.sign(
    {
      sub: String(requestId),
      purpose: OWNER_REVIEW_PURPOSE,
      v: Number(linkVersion)
    },
    secret,
    { expiresIn: OWNER_REVIEW_TOKEN_EXPIRES }
  );
}

function verifyOwnerReviewToken(token) {
  const secret = getOwnerReviewSecret();
  if (!secret) {
    throw new Error('OWNER_REVIEW_JWT_SECRET or JWT_SECRET must be set');
  }
  const decoded = jwt.verify(token, secret);
  if (decoded.purpose !== OWNER_REVIEW_PURPOSE || !decoded.sub) {
    throw new jwt.JsonWebTokenError('Invalid owner review token');
  }
  if (!Number.isFinite(Number(decoded.v))) {
    throw new jwt.JsonWebTokenError('Invalid token version');
  }
  return { requestId: decoded.sub, version: Number(decoded.v) };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] || c;
  });
}

function buildPublicApiBase(req) {
  const envBase = String(process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (envBase) return envBase;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function getRefreshCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  const options = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
  if (isProduction && process.env.COOKIE_DOMAIN) {
    options.domain = process.env.COOKIE_DOMAIN;
  }
  return options;
}

function sanitizePublicIdPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'proof';
}

function uploadProofBufferToCloudinary(file, folder, publicIdPrefix) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const isPdf = file.mimetype === 'application/pdf' || ext === '.pdf';
    const publicId = `${publicIdPrefix}-${Date.now()}`;

    const uploadOptions = {
      folder,
      public_id: publicId,
      resource_type: isPdf ? 'raw' : 'image'
    };

    if (!isPdf) {
      uploadOptions.format = 'webp';
      uploadOptions.transformation = [{ quality: 'auto' }];
    }

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) {
        return reject(new Error(`Proof upload failed: ${error.message}`));
      }
      return resolve({
        url: result.secure_url,
        publicId: result.public_id,
        resourceType: result.resource_type
      });
    });

    stream.end(file.buffer);
  });
}

async function resolveWholesalerProofUrls(req, payload) {
  const files = req.files || {};
  const idProofFile = Array.isArray(files.idProof) ? files.idProof[0] : null;
  const businessProofFile = Array.isArray(files.businessAddressProof) ? files.businessAddressProof[0] : null;

  const uploads = [];

  if (idProofFile) {
    uploads.push(
      uploadProofBufferToCloudinary(
        idProofFile,
        'wholesaler/proofs/id',
        sanitizePublicIdPart(`${payload.fullName}-id-proof`)
      ).then((r) => {
        payload.idProofUpload = r.url;
      })
    );
  }

  if (businessProofFile) {
    uploads.push(
      uploadProofBufferToCloudinary(
        businessProofFile,
        'wholesaler/proofs/business',
        sanitizePublicIdPart(`${payload.fullName}-business-proof`)
      ).then((r) => {
        payload.businessAddressProofUpload = r.url;
      })
    );
  }

  if (uploads.length) {
    await Promise.all(uploads);
  }
}

function generateAccessToken(userId, userType = 'user', role = 'user') {
  return jwt.sign(
    { id: userId, type: 'access', userType, role },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
}

function generateRefreshToken(userId) {
  return jwt.sign(
    { id: userId, type: 'refresh' },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_EXPIRES }
  );
}

exports.submitWholesalerRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const payload = {
      fullName: req.body.fullName,
      whatsappNumber: normalizePhone(req.body.whatsappNumber),
      mobileNumber: normalizePhone(req.body.mobileNumber),
      email: String(req.body.email || '').trim().toLowerCase(),
      permanentAddress: req.body.permanentAddress,
      haveShop: req.body.haveShop === true || req.body.haveShop === 'true',
      businessAddress: req.body.businessAddress,
      deliveryAddress: req.body.deliveryAddress,
      sellingPlaceFrom: req.body.sellingPlaceFrom,
      sellingZoneCity: req.body.sellingZoneCity,
      productCategory: req.body.productCategory,
      monthlyEstimatedPurchase: Number(req.body.monthlyEstimatedPurchase),
      idProofUpload: req.body.idProofUpload,
      businessAddressProofUpload: req.body.businessAddressProofUpload
    };

    await resolveWholesalerProofUrls(req, payload);

    if (!/^\d{10}$/.test(payload.mobileNumber)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit mobileNumber is required' });
    }
    if (!/^\d{10}$/.test(payload.whatsappNumber)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit whatsappNumber is required' });
    }
    if (!payload.email || !payload.fullName || !payload.permanentAddress) {
      return res.status(400).json({ success: false, message: 'Missing required wholesaler details' });
    }
    if (!payload.idProofUpload || !payload.businessAddressProofUpload) {
      return res.status(400).json({
        success: false,
        message:
          'idProofUpload and businessAddressProofUpload are required (provide URLs or upload files as idProof/businessAddressProof)'
      });
    }

    const existingPending = await WholesalerDetails.findOne({
      status: 'pending',
      $or: [{ mobileNumber: payload.mobileNumber }, { email: payload.email }]
    }).select('_id');

    if (existingPending) {
      return res.status(409).json({
        success: false,
        message: 'A pending request already exists for this mobile/email',
        requestId: existingPending._id
      });
    }

    const requestDoc = await WholesalerDetails.create({
      ...payload,
      userId: null,
      isApproved: false,
      status: 'pending',
      ownerReviewLinkVersion: 0
    });

    return res.status(201).json({
      success: true,
      message: 'Wholesaler request submitted successfully. Admin will notify the owner for review.',
      request: {
        id: requestDoc._id,
        status: requestDoc.status,
        fullName: requestDoc.fullName,
        mobileNumber: requestDoc.mobileNumber
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error submitting wholesaler request', error: error.message });
  }
};

exports.listWholesalerRequests = async (req, res) => {
  try {
    const allowedStatuses = ['pending', 'approved', 'rejected', 'activated'];
    const status = String(req.query.status || 'all').toLowerCase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const query =
      status === 'all'
        ? {}
        : allowedStatuses.includes(status)
          ? { status }
          : {};

    const total = await WholesalerDetails.countDocuments(query);
    const rows = await WholesalerDetails.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        'fullName whatsappNumber mobileNumber sellingZoneCity productCategory monthlyEstimatedPurchase status createdAt ownerNotifiedAt ownerReviewLinkVersion'
      );
    return res.status(200).json({
      success: true,
      filters: {
        status: status === 'all' || allowedStatuses.includes(status) ? status : 'all'
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1)
      },
      requests: rows
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error fetching wholesaler requests', error: error.message });
  }
};

exports.getWholesalerRequestSummary = async (req, res) => {
  try {
    const counts = await WholesalerDetails.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const summary = {
      all: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      activated: 0
    };

    for (const row of counts) {
      const key = String(row._id || '').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(summary, key)) {
        summary[key] = Number(row.count || 0);
        summary.all += Number(row.count || 0);
      }
    }

    return res.status(200).json({ success: true, summary });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error fetching request summary', error: error.message });
  }
};

exports.getWholesalerRequestDetails = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    const doc = await WholesalerDetails.findById(req.params.id).populate('reviewedBy ownerNotifiedBy linkedUserId', 'name email phone userType role');
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }
    return res.status(200).json({ success: true, request: doc });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error fetching request details', error: error.message });
  }
};

/**
 * Admin: bump review link version, record notify audit, return wa.me payload for owner.
 * Each call invalidates any previously issued owner review link for this request.
 */
exports.buildNotifyOwnerPayload = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const ownerPhoneRaw = String(process.env.OWNER_WHATSAPP_NUMBER || '').trim();
    const ownerWaPath = rawDigitsToWaMePath(ownerPhoneRaw);
    if (!ownerWaPath) {
      return res.status(503).json({
        success: false,
        message: 'OWNER_WHATSAPP_NUMBER is not configured (10-digit or 91XXXXXXXXXX)'
      });
    }

    let doc;
    try {
      doc = await WholesalerDetails.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        {
          $inc: { ownerReviewLinkVersion: 1 },
          $set: {
            ownerNotifiedAt: new Date(),
            ownerNotifiedBy: req.userId ? new mongoose.Types.ObjectId(req.userId) : null
          }
        },
        { new: true }
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid request id' });
    }

    if (!doc) {
      return res.status(409).json({
        success: false,
        message: 'Request not found or not in pending status'
      });
    }

    let token;
    try {
      token = signOwnerReviewToken(doc._id, doc.ownerReviewLinkVersion);
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message || 'Cannot sign review token' });
    }

    const apiBase = buildPublicApiBase(req);
    if (!apiBase) {
      return res.status(503).json({
        success: false,
        message: 'Set PUBLIC_API_BASE_URL (or API_PUBLIC_BASE_URL) so the owner review link can be generated'
      });
    }

    const reviewUrl = `${apiBase}/api/wholesaler/owner-review?t=${encodeURIComponent(token)}`;
    const messagePlain = [
      '*Wholesaler request — action required*',
      `Name: ${doc.fullName}`,
      `Mobile: ${doc.mobileNumber}`,
      `City: ${doc.sellingZoneCity}`,
      `Category: ${doc.productCategory}`,
      '',
      'Open this secure link to approve or reject:',
      reviewUrl
    ].join('\n');

    const waMeUrl = `https://wa.me/${ownerWaPath}?text=${encodeURIComponent(messagePlain)}`;

    return res.status(200).json({
      success: true,
      waMeUrl,
      messagePlain,
      reviewUrl,
      ownerWaPath,
      request: {
        id: doc._id,
        status: doc.status,
        ownerReviewLinkVersion: doc.ownerReviewLinkVersion,
        ownerNotifiedAt: doc.ownerNotifiedAt
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error building owner notify payload', error: error.message });
  }
};

/**
 * Admin: prefilled WhatsApp for the applicant after owner decision (approved / rejected).
 */
exports.buildNotifyApplicantPayload = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const doc = await WholesalerDetails.findById(req.params.id).select(
      'fullName whatsappNumber mobileNumber status email'
    );
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }

    const applicantPath = rawDigitsToWaMePath(doc.whatsappNumber);
    if (!applicantPath) {
      return res.status(400).json({ success: false, message: 'Applicant WhatsApp number is invalid' });
    }

    if (doc.status === 'pending') {
      return res.status(409).json({
        success: false,
        message: 'Request is still pending owner review. Notify the applicant after a decision.'
      });
    }

    if (doc.status === 'activated') {
      return res.status(409).json({
        success: false,
        message: 'Applicant has already completed activation'
      });
    }

    let messagePlain;
    if (doc.status === 'approved') {
      messagePlain = [
        `Hello ${doc.fullName},`,
        '',
        '*Good news:* your wholesaler application has been approved.',
        '',
        'Complete account setup: request OTP on the app/website using your registered mobile number, then set your password.',
        `Registered mobile: ${doc.mobileNumber}`,
        '',
        '— Team'
      ].join('\n');
    } else if (doc.status === 'rejected') {
      messagePlain = [
        `Hello ${doc.fullName},`,
        '',
        'Thank you for your interest. Unfortunately your wholesaler application was not approved at this time.',
        '',
        '— Team'
      ].join('\n');
    } else {
      return res.status(409).json({ success: false, message: `Unexpected status: ${doc.status}` });
    }

    const waMeUrl = `https://wa.me/${applicantPath}?text=${encodeURIComponent(messagePlain)}`;

    return res.status(200).json({
      success: true,
      waMeUrl,
      messagePlain,
      applicantWaPath: applicantPath,
      request: { id: doc._id, status: doc.status }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error building applicant notify payload', error: error.message });
  }
};

function requestSummaryForOwner(doc) {
  return {
    id: doc._id,
    fullName: doc.fullName,
    whatsappNumber: doc.whatsappNumber,
    mobileNumber: doc.mobileNumber,
    email: doc.email,
    permanentAddress: doc.permanentAddress,
    haveShop: doc.haveShop,
    businessAddress: doc.businessAddress,
    deliveryAddress: doc.deliveryAddress,
    sellingPlaceFrom: doc.sellingPlaceFrom,
    sellingZoneCity: doc.sellingZoneCity,
    productCategory: doc.productCategory,
    monthlyEstimatedPurchase: doc.monthlyEstimatedPurchase,
    idProofUpload: doc.idProofUpload,
    businessAddressProofUpload: doc.businessAddressProofUpload,
    status: doc.status,
    createdAt: doc.createdAt
  };
}

exports.getOwnerReviewPage = async (req, res) => {
  try {
    const token = String(req.query.t || req.query.token || '').trim();
    if (!token) {
      return res.status(400).send('Missing review token');
    }

    let payload;
    try {
      payload = verifyOwnerReviewToken(token);
    } catch (e) {
      const msg = e.name === 'TokenExpiredError' ? 'This review link has expired.' : 'Invalid or tampered review link.';
      return res.status(401).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review link</title></head><body><p>${escapeHtml(msg)}</p></body></html>`);
    }

    if (!mongoose.Types.ObjectId.isValid(payload.requestId)) {
      return res.status(400).send('Invalid request reference');
    }

    const doc = await WholesalerDetails.findById(payload.requestId);
    if (!doc) {
      return res.status(404).send('Request not found');
    }

    if (doc.ownerReviewLinkVersion !== payload.version) {
      return res.status(401).send('This review link is no longer valid. Ask admin to send a new link.');
    }

    if (doc.status !== 'pending') {
      const label = doc.status === 'approved' ? 'approved' : doc.status === 'rejected' ? 'rejected' : doc.status;
      return res
        .status(200)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Already decided</title></head><body><p>This request was already <strong>${escapeHtml(label)}</strong>.</p></body></html>`
        );
    }

    const acceptJson = req.headers.accept && req.headers.accept.includes('application/json');
    const apiBase = buildPublicApiBase(req);
    if (!apiBase) {
      const msg = 'Set PUBLIC_API_BASE_URL (or API_PUBLIC_BASE_URL) so review actions can be submitted.';
      if (acceptJson) {
        return res.status(503).json({ success: false, message: msg });
      }
      return res.status(503).type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><p>${escapeHtml(msg)}</p></body></html>`);
    }

    if (acceptJson) {
      return res.status(200).json({
        success: true,
        request: requestSummaryForOwner(doc),
        decisionEndpoint: `${apiBase}/api/wholesaler/owner-review/decision`,
        tokenExpiresIn: OWNER_REVIEW_TOKEN_EXPIRES
      });
    }

    const safe = (v) => escapeHtml(v);
    const rows = [
      ['Name', doc.fullName],
      ['WhatsApp', doc.whatsappNumber],
      ['Mobile', doc.mobileNumber],
      ['Email', doc.email],
      ['Permanent address', doc.permanentAddress],
      ['Have shop', doc.haveShop ? 'Yes' : 'No'],
      ['Business address', doc.businessAddress],
      ['Delivery address', doc.deliveryAddress],
      ['Selling from', doc.sellingPlaceFrom],
      ['City / zone', doc.sellingZoneCity],
      ['Category', doc.productCategory],
      ['Est. monthly purchase', String(doc.monthlyEstimatedPurchase)],
      ['ID proof URL', doc.idProofUpload],
      ['Business proof URL', doc.businessAddressProofUpload]
    ]
      .map(([k, v]) => `<tr><th style="text-align:left;padding:4px 8px;border:1px solid #ccc">${safe(k)}</th><td style="padding:4px 8px;border:1px solid #ccc;word-break:break-all">${safe(v)}</td></tr>`)
      .join('');

    const tokenField = safe(token);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Wholesaler review</title>
  <style>body{font-family:system-ui,sans-serif;margin:16px;max-width:720px} table{border-collapse:collapse;width:100%} button{padding:12px 20px;font-size:16px;margin:8px 8px 0 0;border-radius:8px;border:none;cursor:pointer} .approve{background:#166534;color:#fff} .reject{background:#991b1b;color:#fff}</style>
</head>
<body>
  <h1>Wholesaler application</h1>
  <p>Review the details below, then choose an action.</p>
  <table>${rows}</table>
  <form method="post" action="${safe(`${apiBase}/api/wholesaler/owner-review/decision`)}" style="margin-top:20px">
    <input type="hidden" name="token" value="${tokenField}" />
    <input type="hidden" name="decision" value="approve" />
    <button type="submit" class="approve">Approve</button>
  </form>
  <form method="post" action="${safe(`${apiBase}/api/wholesaler/owner-review/decision`)}" style="margin-top:8px">
    <input type="hidden" name="token" value="${tokenField}" />
    <input type="hidden" name="decision" value="reject" />
    <label style="display:block;margin-top:12px">Optional note (rejection only)</label>
    <textarea name="reason" maxlength="500" rows="3" style="width:100%;box-sizing:border-box"></textarea>
    <button type="submit" class="reject" style="margin-top:8px">Reject</button>
  </form>
</body>
</html>`;

    return res.status(200).type('html').send(html);
  } catch (error) {
    return res.status(500).send('Server error');
  }
};

exports.postOwnerReviewDecision = async (req, res) => {
  try {
    const val = validationResult(req);
    if (!val.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: val.array() });
    }

    const token = String(req.body.token || '').trim();
    const decision = String(req.body.decision || '').toLowerCase();
    const reason = String(req.body.reason || '').trim().slice(0, 500);

    if (!token || !['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'token and decision (approve|reject) are required' });
    }

    let payload;
    try {
      payload = verifyOwnerReviewToken(token);
    } catch (e) {
      const code = e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      return res.status(401).json({ success: false, message: 'Invalid or expired review token', code });
    }

    if (!mongoose.Types.ObjectId.isValid(payload.requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid request reference' });
    }

    const now = new Date();
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    const update = {
      status: nextStatus,
      isApproved: decision === 'approve',
      reviewedAt: now,
      reviewedBy: null,
      reviewReason: decision === 'reject' ? reason : ''
    };

    const updated = await WholesalerDetails.findOneAndUpdate(
      {
        _id: payload.requestId,
        status: 'pending',
        ownerReviewLinkVersion: payload.version
      },
      { $set: update },
      { new: true }
    );

    if (!updated) {
      const current = await WholesalerDetails.findById(payload.requestId).select('status ownerReviewLinkVersion');
      if (!current) {
        return res.status(404).json({ success: false, message: 'Request not found' });
      }
      if (current.status !== 'pending') {
        return res.status(409).json({
          success: false,
          message: `This request was already ${current.status}`,
          status: current.status
        });
      }
      if (current.ownerReviewLinkVersion !== payload.version) {
        return res.status(409).json({
          success: false,
          message: 'This link is no longer valid. Ask admin to send a new owner notification.',
          code: 'LINK_VERSION_MISMATCH'
        });
      }
      return res.status(409).json({ success: false, message: 'Could not apply decision. Try again.' });
    }

    if (req.is('application/json')) {
      return res.status(200).json({
        success: true,
        message: decision === 'approve' ? 'Request approved.' : 'Request rejected.',
        request: { id: updated._id, status: updated.status }
      });
    }

    const msg =
      decision === 'approve'
        ? 'Thank you. The wholesaler request has been approved.'
        : 'The wholesaler request has been rejected.';
    return res
      .status(200)
      .type('html')
      .send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Done</title></head><body><p>${escapeHtml(msg)}</p></body></html>`
      );
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error processing decision', error: error.message });
  }
};

exports.approveWholesalerRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    const doc = await WholesalerDetails.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Request already ${doc.status}` });
    }

    doc.status = 'approved';
    doc.isApproved = true;
    doc.reviewReason = String(req.body.reason || '').trim();
    doc.reviewedBy = req.userId || null;
    doc.reviewedAt = new Date();
    await doc.save();

    return res.status(200).json({
      success: true,
      message: 'Wholesaler request approved (superadmin override). Applicant can request activation OTP.',
      request: { id: doc._id, status: doc.status, reviewedAt: doc.reviewedAt }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error approving wholesaler request', error: error.message });
  }
};

exports.rejectWholesalerRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    const doc = await WholesalerDetails.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Request already ${doc.status}` });
    }

    doc.status = 'rejected';
    doc.isApproved = false;
    doc.reviewReason = String(req.body.reason || '').trim();
    doc.reviewedBy = req.userId || null;
    doc.reviewedAt = new Date();
    await doc.save();

    return res.status(200).json({
      success: true,
      message: 'Wholesaler request rejected (superadmin override)',
      request: { id: doc._id, status: doc.status, reviewedAt: doc.reviewedAt }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error rejecting wholesaler request', error: error.message });
  }
};

exports.sendWholesalerActivationOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const mobileNumber = normalizePhone(req.body.mobileNumber);
    if (!/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit mobileNumber is required' });
    }

    const doc = await WholesalerDetails.findOne({ mobileNumber, status: 'approved' }).sort({ updatedAt: -1 });
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'No approved wholesaler request found for this mobile number'
      });
    }

    const otp = generateOTP();
    doc.activationOtpHash = hashString(otp);
    doc.activationOtpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    doc.activationOtpAttempts = 0;
    doc.activationOtpSentAt = new Date();
    await doc.save();

    await sendOTP(doc.mobileNumber, otp);

    return res.status(200).json({
      success: true,
      message: 'Activation OTP sent successfully',
      mobileNumber: doc.mobileNumber
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error sending activation OTP', error: error.message });
  }
};

exports.verifyWholesalerActivationOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const mobileNumber = normalizePhone(req.body.mobileNumber);
    const otp = String(req.body.otp || '').trim();
    const password = String(req.body.password || '');

    if (!/^\d{10}$/.test(mobileNumber) || !otp || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'mobileNumber, otp and password (min 6 chars) are required'
      });
    }

    const doc = await WholesalerDetails.findOne({ mobileNumber, status: 'approved' })
      .sort({ updatedAt: -1 })
      .select('+activationOtpHash');

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'No approved request found for this mobile number'
      });
    }

    if (!doc.activationOtpHash || !doc.activationOtpExpiresAt || new Date() > doc.activationOtpExpiresAt) {
      return res.status(400).json({ success: false, message: 'OTP expired or not requested' });
    }

    if (doc.activationOtpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: 'Too many invalid attempts. Request OTP again.' });
    }

    const incomingHash = hashString(otp);
    if (incomingHash !== doc.activationOtpHash) {
      doc.activationOtpAttempts += 1;
      await doc.save();
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    let user = await User.findOne({
      $or: [{ phone: doc.mobileNumber }, { email: doc.email }]
    }).select('+password +refreshTokens');

    if (user && user.userType === 'admin') {
      return res.status(409).json({ success: false, message: 'This mobile/email belongs to an admin account' });
    }

    if (!user) {
      user = new User({
        name: doc.fullName,
        email: doc.email,
        phone: doc.mobileNumber,
        password,
        userType: 'wholesaler',
        role: 'wholesaler',
        status: 'active',
        isPhoneVerified: true,
        isEmailVerified: false,
        registrationMethod: 'phone',
        isProfileComplete: true,
        lastLoginMethod: 'otp'
      });
    } else {
      user.name = user.name || doc.fullName;
      user.email = user.email || doc.email;
      user.phone = user.phone || doc.mobileNumber;
      user.password = password;
      user.userType = 'wholesaler';
      user.role = user.role === 'admin' ? user.role : 'wholesaler';
      user.status = 'active';
      user.isPhoneVerified = true;
      user.isProfileComplete = true;
      user.lastLoginMethod = 'otp';
    }

    const accessToken = generateAccessToken(user._id, user.userType, user.role);
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefreshToken = hashString(refreshToken);

    user.refreshTokens = user.refreshTokens || [];
    user.refreshTokens = user.refreshTokens.filter((t) => t.expiresAt > new Date());
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      deviceInfo: req.headers['user-agent'] || 'Unknown'
    });
    await user.save();

    doc.status = 'activated';
    doc.linkedUserId = user._id;
    doc.activatedAt = new Date();
    doc.activationOtpHash = null;
    doc.activationOtpExpiresAt = null;
    doc.activationOtpAttempts = 0;
    await doc.save();

    res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());

    return res.status(200).json({
      success: true,
      message: 'Wholesaler account activated and logged in successfully',
      accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        role: user.role
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error verifying activation OTP', error: error.message });
  }
};
