const { cloudinary } = require('../config/cloudinary.config');

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

module.exports = { uploadToCloudinary, deleteFromCloudinary };
