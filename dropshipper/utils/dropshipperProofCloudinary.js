'use strict';

/**
 * Dropshipper registration proof uploads — Cloudinary only.
 * Isolated from ecomm product/return helpers; reuses shared cloudinary config.
 */

const { cloudinary } = require('../../config/cloudinary.config');
const { optimizeProductImageBuffer } = require('../../utils/cloudinaryHelper');
const { createDropshipperError } = require('./dropshipperHttp');

const MAX_PROOF_BYTES = 5 * 1024 * 1024;

/**
 * @param {Express.Multer.File} file
 * @param {string} folder e.g. dropshipper/registration/{slug}/id
 * @returns {Promise<{ url: string, publicId: string, kind: 'image'|'pdf' }>}
 */
async function uploadDropshipperRegistrationProofToCloudinary(file, folder) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw createDropshipperError(400, 'PROOF_UPLOAD_INVALID', 'Proof file is empty or invalid');
  }
  if (file.buffer.length > MAX_PROOF_BYTES) {
    throw createDropshipperError(400, 'PROOF_TOO_LARGE', 'Proof file must be 5MB or smaller');
  }

  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) {
    throw createDropshipperError(
      503,
      'CLOUDINARY_NOT_CONFIGURED',
      'Document upload is temporarily unavailable'
    );
  }

  const isPdf = file.mimetype === 'application/pdf';
  const resourceType = isPdf ? 'raw' : 'image';
  let buffer = file.buffer;
  if (!isPdf) {
    try {
      buffer = await optimizeProductImageBuffer(file.buffer);
    } catch (err) {
      throw createDropshipperError(
        400,
        'PROOF_IMAGE_INVALID',
        err?.message || 'Could not process proof image'
      );
    }
  }

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: resourceType,
      public_id: `${isPdf ? 'doc' : 'img'}-${Date.now()}`
    };
    if (!isPdf) {
      uploadOptions.format = 'webp';
      uploadOptions.transformation = [{ quality: 'auto' }];
    }

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) {
        reject(
          createDropshipperError(
            502,
            'PROOF_UPLOAD_FAILED',
            `Proof upload failed: ${error.message || 'Cloudinary error'}`
          )
        );
        return;
      }
      if (!result?.secure_url) {
        reject(
          createDropshipperError(502, 'PROOF_UPLOAD_FAILED', 'Proof upload returned no URL')
        );
        return;
      }
      resolve({
        kind: isPdf ? 'pdf' : 'image',
        url: result.secure_url,
        publicId: result.public_id
      });
    });
    stream.end(buffer);
  });
}

module.exports = {
  uploadDropshipperRegistrationProofToCloudinary,
  MAX_PROOF_BYTES
};
