const sharp = require('sharp');
const { cloudinary } = require('../config/cloudinary.config');

const DEFAULT_MAX_WIDTH = Math.min(
  4096,
  Math.max(256, Number(process.env.PRODUCT_IMAGE_MAX_WIDTH) || 1500)
);
const DEFAULT_WEBP_QUALITY = Math.min(
  100,
  Math.max(50, Number(process.env.PRODUCT_IMAGE_WEBP_QUALITY) || 82)
);
const DEFAULT_WEBP_EFFORT = Math.min(
  6,
  Math.max(0, Number(process.env.PRODUCT_IMAGE_WEBP_EFFORT) || 4)
);

/**
 * Production pipeline: EXIF-aware rotate, cap width, encode WebP before Cloudinary.
 * Keeps responses and stored assets consistently compressed.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} input
 * @param {{ maxWidth?: number, quality?: number, effort?: number }} [options]
 * @returns {Promise<Buffer>}
 */
async function optimizeProductImageBuffer(input, options = {}) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (input instanceof ArrayBuffer) {
    buf = Buffer.from(input);
  } else if (input && input.buffer instanceof ArrayBuffer) {
    buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError('optimizeProductImageBuffer: expected Buffer or array-backed bytes');
  }

  if (!buf.length) {
    throw new Error('optimizeProductImageBuffer: empty buffer');
  }

  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const quality = options.quality ?? DEFAULT_WEBP_QUALITY;
  const effort = options.effort ?? DEFAULT_WEBP_EFFORT;

  try {
    return await sharp(buf, { animated: true, limitInputPixels: 268_402_689 })
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality, effort, smartSubsample: true })
      .toBuffer();
  } catch (err) {
    const wrapped = new Error(`Image optimization failed: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * Upload image buffer to Cloudinary
 * @param {Buffer} fileBuffer - Image file buffer from Multer
 * @param {String} folderPath - Cloudinary folder path (e.g., 'products')
 * @returns {Promise<{url: String, publicId: String}>}
 */

const uploadToCloudinary = async (fileBuffer, folderPath = 'products', publicIdName = null) => {
  return new Promise((resolve, reject) => {
    const opts = {
      folder: folderPath,
      resource_type: 'image',
      format: 'webp', // Force WebP storage
      transformation: [
        { quality: 'auto' }
      ]
    };

    if (publicIdName) {
      opts.public_id = publicIdName;
    }

    const stream = cloudinary.uploader.upload_stream(
      opts,
      (error, result) => {
        if (error) {
          reject(new Error(`Cloudinary upload error: ${error.message}`));
        } else {
          resolve({
            url: result.secure_url,
            publicId: result.public_id
          });
        }
      }
    );

    stream.end(fileBuffer);
  });
};



/**
 * Delete image from Cloudinary
 * @param {String} publicId - Cloudinary public ID
 */
const deleteFromCloudinary = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('Failed to delete image from Cloudinary:', error.message);
  }
};

module.exports = {
  uploadToCloudinary,
  deleteFromCloudinary,
  optimizeProductImageBuffer
};
