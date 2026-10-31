/**
 * Compress gift-enquiry images, then store on Cloudflare R2.
 * PDFs are stored as-is. Failed runs roll back any objects already written.
 */

const crypto = require('crypto');
const path = require('path');
const logger = require('../utils/logger');
const { optimizeProductImageBuffer } = require('../utils/cloudinaryHelper');
const { uploadBufferToR2, deleteFromR2ByKey, isR2Configured } = require('../utils/r2Storage');
const {
  detectBufferKind,
  isAllowedLogoKind,
  isAllowedReferenceKind,
} = require('../utils/giftEnquiryFileSignature');
const {
  MAX_GIFT_FILE_BYTES,
  MAX_REFERENCE_PHOTOS,
  MAX_LOGOS,
  createHttpError,
} = require('../utils/corporateGiftEnquiryValidation');

function collectFieldFiles(req, field) {
  const files = req.files && req.files[field];
  return Array.isArray(files) ? files.filter(Boolean) : [];
}

function sanitizeOriginalName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 180) || 'file';
}

function sanitizePublicIdPart(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'file'
  );
}

function r2KeyFromPublicId(publicId) {
  const raw = String(publicId || '');
  return raw.startsWith('r2:') ? raw.slice(3) : raw;
}

function assertFileBuffer(file, field) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw createHttpError(400, 'INVALID_FILE_TYPE', 'Uploaded file is empty or unreadable', field);
  }
  if (file.buffer.length > MAX_GIFT_FILE_BYTES) {
    throw createHttpError(400, 'FILE_TOO_LARGE', 'Each file must be 5 MB or smaller', field);
  }
}

function inspectFile(file, { allowedKinds, field, allowPdf }) {
  assertFileBuffer(file, field);
  const kind = detectBufferKind(file.buffer);
  if (!kind || !allowedKinds(kind)) {
    throw createHttpError(
      400,
      'INVALID_FILE_TYPE',
      allowPdf
        ? 'Logo files must be images (JPG, JPEG, PNG, WEBP) or PDF.'
        : 'Reference photos must be image files (JPG, JPEG, PNG, WEBP). PDF is not allowed.',
      field
    );
  }
  return kind;
}

async function rollbackUploads(assets) {
  for (const asset of assets) {
    const key = r2KeyFromPublicId(asset?.publicId);
    if (!key) continue;
    try {
      await deleteFromR2ByKey(key);
    } catch (err) {
      logger.error('[gift-enquiry] R2 rollback failed', {
        key,
        message: err.message,
      });
    }
  }
}

async function uploadOneFile(file, { kind, folder, publicIdPrefix, assetKind }) {
  const originalName = sanitizeOriginalName(file.originalname);
  const publicIdName = `${sanitizePublicIdPart(publicIdPrefix)}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')}`;

  if (kind === 'pdf') {
    const upload = await uploadBufferToR2({
      buffer: file.buffer,
      folderPath: folder,
      publicIdName,
      contentType: 'application/pdf',
      extension: 'pdf',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    return {
      url: upload.url,
      publicId: `r2:${upload.key}`,
      originalName,
      mimeType: 'application/pdf',
      sizeBytes: file.buffer.length,
      kind: assetKind,
    };
  }

  let optimized;
  try {
    optimized = await optimizeProductImageBuffer(file.buffer);
  } catch (err) {
    logger.warn('[gift-enquiry] image compress failed', { message: err.message });
    throw createHttpError(
      400,
      'INVALID_FILE_TYPE',
      'Could not process this image. Use JPG, PNG, or WEBP.',
      assetKind === 'logo' ? 'logos' : 'referencePhotos'
    );
  }

  const upload = await uploadBufferToR2({
    buffer: optimized,
    folderPath: folder,
    publicIdName,
    contentType: 'image/webp',
    extension: 'webp',
    cacheControl: 'public, max-age=31536000, immutable',
  });

  return {
    url: upload.url,
    publicId: `r2:${upload.key}`,
    originalName,
    mimeType: 'image/webp',
    sizeBytes: optimized.length,
    kind: assetKind,
  };
}

function pickEnquiryFiles(req) {
  return {
    referencePhotos: collectFieldFiles(req, 'referencePhotos'),
    logos: collectFieldFiles(req, 'logos'),
  };
}

function validateEnquiryFiles(enquiryType, files) {
  const refs = files.referencePhotos;
  const logos = files.logos;

  if (enquiryType === 'bulk' && (refs.length > 0 || logos.length > 0)) {
    throw createHttpError(
      400,
      'FILES_NOT_ALLOWED',
      'Bulk enquiries cannot include logo or reference files.',
      'files'
    );
  }

  if (enquiryType !== 'custom') {
    return { referencePhotos: [], logos: [] };
  }

  if (refs.length < 1) {
    throw createHttpError(
      400,
      'REFERENCE_PHOTOS_REQUIRED',
      'Upload at least 1 reference photo (max 3).',
      'referencePhotos'
    );
  }
  if (refs.length > MAX_REFERENCE_PHOTOS) {
    throw createHttpError(
      400,
      'TOO_MANY_FILES',
      'Maximum 3 reference photos are allowed.',
      'referencePhotos'
    );
  }
  if (logos.length > MAX_LOGOS) {
    throw createHttpError(400, 'TOO_MANY_FILES', 'Maximum 3 logo files are allowed.', 'logos');
  }

  const inspectedRefs = refs.map((file) => ({
    file,
    kind: inspectFile(file, {
      allowedKinds: isAllowedReferenceKind,
      field: 'referencePhotos',
      allowPdf: false,
    }),
  }));
  const inspectedLogos = logos.map((file) => ({
    file,
    kind: inspectFile(file, {
      allowedKinds: isAllowedLogoKind,
      field: 'logos',
      allowPdf: true,
    }),
  }));

  return { inspectedRefs, inspectedLogos };
}

/**
 * Upload custom-enquiry files to R2. Caller must rollback if DB write fails.
 * @returns {Promise<{ logos: object[], referencePhotos: object[] }>}
 */
async function uploadEnquiryAssets(payload, files) {
  if (payload.enquiryType !== 'custom') {
    return { logos: [], referencePhotos: [] };
  }

  if (!isR2Configured()) {
    throw createHttpError(
      503,
      'MEDIA_STORAGE_UNAVAILABLE',
      'File storage is temporarily unavailable. Please try again shortly.'
    );
  }

  const inspected = validateEnquiryFiles(payload.enquiryType, files);
  const jobs = [];

  for (const item of inspected.inspectedRefs) {
    jobs.push({
      file: item.file,
      kind: item.kind,
      folder: 'gift-enquiries/references',
      publicIdPrefix: `ref-${payload.phone}`,
      assetKind: 'reference',
    });
  }
  for (const item of inspected.inspectedLogos) {
    jobs.push({
      file: item.file,
      kind: item.kind,
      folder: 'gift-enquiries/logos',
      publicIdPrefix: `logo-${payload.phone}`,
      assetKind: 'logo',
    });
  }

  const uploaded = [];
  try {
    for (const job of jobs) {
      const asset = await uploadOneFile(job.file, job);
      uploaded.push(asset);
    }
  } catch (err) {
    await rollbackUploads(uploaded);
    throw err;
  }

  return {
    referencePhotos: uploaded.filter((a) => a.kind === 'reference'),
    logos: uploaded.filter((a) => a.kind === 'logo'),
  };
}

module.exports = {
  pickEnquiryFiles,
  validateEnquiryFiles,
  uploadEnquiryAssets,
  rollbackUploads,
};
