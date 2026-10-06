'use strict';

/**
 * Normalize dropshipper registration body from JSON or multipart + Cloudinary proof uploads.
 * Does not touch ecomm / wholesale storefronts.
 */

const { uploadDropshipperRegistrationProofToCloudinary } = require('./dropshipperProofCloudinary');
const { createDropshipperError } = require('./dropshipperHttp');

function pickFirstFile(files, ...keys) {
  for (const key of keys) {
    if (Array.isArray(files?.[key]) && files[key][0]) return files[key][0];
  }
  return null;
}

function parseBooleanField(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function emailFolderSlug(email) {
  return (
    String(email || 'applicant')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'applicant'
  );
}

/**
 * @param {import('express').Request} req
 * @param {{ requireProofFiles?: boolean }} [opts]
 */
async function resolveRegistrationRequestBody(req, opts = {}) {
  const body = { ...(req.body || {}) };
  body.haveShop = parseBooleanField(body.haveShop);

  const files = req.files || {};
  const idFile = pickFirstFile(files, 'idProof', 'idProofUpload', 'idProofFile');
  const businessFile = pickFirstFile(
    files,
    'businessAddressProof',
    'businessAddressProofUpload',
    'businessAddressProofFile'
  );

  const folderBase = `dropshipper/registration/${emailFolderSlug(body.email)}`;

  if (idFile) {
    const uploaded = await uploadDropshipperRegistrationProofToCloudinary(
      idFile,
      `${folderBase}/id`
    );
    body.idProofUrl = uploaded.url;
  }
  if (businessFile) {
    const uploaded = await uploadDropshipperRegistrationProofToCloudinary(
      businessFile,
      `${folderBase}/business`
    );
    body.businessAddressProofUrl = uploaded.url;
  }

  if (opts.requireProofFiles) {
    const idUrl = String(body.idProofUrl || body.idProofUpload || '').trim();
    const bizUrl = String(
      body.businessAddressProofUrl || body.businessAddressProofUpload || ''
    ).trim();
    if (!idUrl) {
      throw createDropshipperError(
        400,
        'VALIDATION_ERROR',
        'ID proof is required — upload an image or PDF (idProof)'
      );
    }
    if (!bizUrl) {
      throw createDropshipperError(
        400,
        'VALIDATION_ERROR',
        'Business address proof is required — upload an image or PDF (businessAddressProof)'
      );
    }
  }

  return body;
}

module.exports = {
  resolveRegistrationRequestBody
};
